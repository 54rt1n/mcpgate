#!/usr/bin/env node

/**
 * MCP SDK Client Bridge (index.js)
 * ------------------------------
 * This script:
 * 1. Uses the official Model Context Protocol SDK
 * 2. Creates a client with SSE transport
 * 3. Reads messages from stdin and forwards them to the MCP server
 * 4. Receives messages from the MCP server and forwards them to stdout
 * 5. Provides a bridge between command-line tools and the MCP protocol
 * 
 * With improved reconnection handling that properly re-establishes sessions.
 */

import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

// Create a module to encapsulate the functionality
const MCPGate = (function() {
  // Private state
  let config = {
    url: null,
    sessionId: null,
    debug: true,
    reconnectDelay: 1000,
    maxReconnectAttempts: 5
  };
  
  let state = {
    client: null,
    transport: null,
    readline: null,
    messageQueue: [],
    transportReady: false,
    reconnecting: false,
    reconnectAttempts: 0,
    originalSessionId: null // Store the original session ID for reconnection
  };
  
  // Standard handshake message
  const handshakeMessage = {
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "claude-ai", version: "0.1.0" }
    },
    jsonrpc: "2.0",
    id: 0
  };
  
  // ===== Utility Functions =====
  
  /**
   * Log debug information to stderr
   */
  function log(...args) {
    if (config.debug) {
      console.error('[mcpgate]', ...args);
    }
  }
  
  /**
   * Write an error message to stdout in JSON-RPC format
   */
  function writeErrorMessage(message, data, code = -32000, id = null) {
    // Format the message
    const myMessage = typeof message === 'string' 
      ? message 
      : (message && message.message ? message.message : 'Unknown error');
    
    // Ensure id is never undefined (JSON-RPC spec requires id to be included, can be null)
    const responseId = id !== undefined ? id : null;
    
    // Write to stdout
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: responseId,
      error: {
        code: code,
        message: myMessage,
        data: data || {}
      }
    }) + '\n');
  }
  
  // ===== Connection Management =====
  
  /**
   * Creates a new client and transport instance and connects to the server
   */
  async function createConnection(isReconnect = false) {
    try {
      // Cleanup existing connection if any
      if (state.client) {
        try {
          log('Closing existing client connection before creating new one');
          
          // First, force close the EventSource if it exists to prevent memory leaks
          if (state.transport && state.transport._eventSource) {
            try {
              log('Force closing EventSource connection');
              state.transport._eventSource.close();
              state.transport._eventSource.onopen = null;
              state.transport._eventSource.onmessage = null;
              state.transport._eventSource.onerror = null;
            } catch (err) {
              log(`Error closing EventSource: ${err.message}`);
            }
          }
          
          // Abort any in-flight requests
          if (state.transport && state.transport._abortController) {
            try {
              log('Aborting any in-flight requests');
              state.transport._abortController.abort();
            } catch (err) {
              log(`Error aborting requests: ${err.message}`);
            }
          }
          
          // Finally close the client which should close the transport
          await state.client.close();
        } catch (err) {
          log(`Error closing existing client: ${err.message}`);
        }
      }
      
      // Clear previous instances
      state.client = null;
      state.transport = null;
      
      // Decide which session ID to use
      if (isReconnect) {
        if (state.reconnectAttempts <= 2) {
          // First couple of attempts, try with original session ID
          log(`Reconnecting with original session ID: ${state.originalSessionId}`);
          config.sessionId = state.originalSessionId;
        } else {
          // After multiple failures, try with a new session ID
          const oldSessionId = config.sessionId;
          config.sessionId = randomUUID();
          log(`After ${state.reconnectAttempts - 1} failed attempts, switching to new session ID: ${config.sessionId}`);
        }
      } else {
        // For initial connection, store the session ID
        state.originalSessionId = config.sessionId;
        log(`Initial connection with session ID: ${config.sessionId}`);
      }
      
      log(`Creating connection to ${config.url} with session ID ${config.sessionId}`);
      
      // Create the SSE transport with the session ID in the URL
      const sseUrl = new URL(config.url);
      sseUrl.searchParams.append('session_id', config.sessionId);
      
      // Create the transport with custom init options
      const transport = new SSEClientTransport(sseUrl);
      log('Transport created');
      
      // Store the transport for later access
      state.transport = transport;
      
      // Add debug wrappers
      debugTransport(transport);
      
      // Add custom error handler for the transport
      transport.onerror = (error) => {
        log(`Transport error: ${error.message}`);
        
        // Log connection state without modifying behavior
        if (transport._eventSource) {
          log(`EventSource state: ${transport._eventSource.readyState}`);
        }
        
        // Check if this is a fatal error that requires reconnection
        if (isFatalConnectionError(error)) {
          log('Fatal connection error detected, triggering full reconnection');
          state.transportReady = false;
          
          // Trigger reconnection with a slight delay to avoid rapid reconnect cycles
          startReconnection();
        } else {
          // Non-fatal connection error - signal client to retry current request
          writeErrorMessage(`SSE connection error, client should retry: ${error.message}`);
        }
      };
      
      // Forward all messages from the server to stdout
      transport.onmessage = (message) => {
        // Track responses for debugging
        log(`Wrote message to stdout: ${JSON.stringify(message).substring(0, 150)}${JSON.stringify(message).length > 150 ? '...' : ''}`);
        
        if ('id' in message && 'result' in message) {
          log(`Received response for request ID: ${message.id}`);
        } else if ('method' in message) {
          log(`Received method call: ${message.method}`);
        } else if ('id' in message && 'error' in message) {
          log(`Received error for request ID: ${message.id}: ${message.error.message}`);
        }
      };

      transport.onclose = () => {
        log('Transport closed');
        state.transportReady = false;
        writeErrorMessage('SSE connection closed, client should reconnect');
        
        // Attempt reconnection
        if (!state.reconnecting) {
          startReconnection();
        }
      };
      
      // Reset transport ready state before connecting
      state.transportReady = false;
      
      // Create the client with minimal info
      log('Creating new client instance');
      state.client = new Client({
        name: 'mcpgate',
        version: '1.0.1',
      });
      
      // Connect to the server - this calls transport.start() internally
      log('Connecting to server...');
      try {
        await state.client.connect(transport);
        log('Connected successfully');
        
        // Connection successful - reset reconnection attempts
        state.reconnectAttempts = 0;
        state.reconnecting = false;
        
        // Process any queued messages
        if (state.messageQueue.length > 0) {
          log(`Connection established, processing ${state.messageQueue.length} queued messages`);
          await processQueue(transport);
        }
        
        return true;
      } catch (connectError) {
        log(`Error during client.connect(): ${connectError.message}`);
        throw connectError;
      }
    } catch (error) {
      log(`Connection error: ${error.message}`);
      if (error.stack) {
        log(`Error stack: ${error.stack}`);
      }
      
      // Check if we should retry
      if (isReconnect) {
        if (state.reconnectAttempts < config.maxReconnectAttempts) {
          log(`Reconnection attempt ${state.reconnectAttempts} failed, will retry again`);
          return false;
        } else {
          log(`Maximum reconnection attempts (${config.maxReconnectAttempts}) reached, giving up`);
          writeErrorMessage(`Failed to reconnect after ${config.maxReconnectAttempts} attempts: ${error.message}`);
          return false;
        }
      } else {
        // Initial connection failed
        writeErrorMessage(error);
        process.exit(1);
      }
    }
  }
  
  /**
   * Check if an error is a fatal connection error that requires full reconnection
   */
  function isFatalConnectionError(error) {
    const message = typeof error === 'string' ? error : error.message;
    
    // Error messages that indicate a need for full reconnection
    return (
      message.includes('Could not find session') ||
      message.includes('404') ||
      message.includes('Connection lost') ||
      message.includes('fetch failed') ||
      message.includes('network error') ||
      message.includes('Not connected')
    );
  }
  
  /**
   * Start the reconnection process
   */
  function startReconnection() {
    if (state.reconnecting) {
      log('Reconnection already in progress, skipping');
      return;
    }
    
    state.reconnecting = true;
    state.reconnectAttempts++;
    
    // Implement exponential backoff with a cap
    const delay = Math.min(
      config.reconnectDelay * Math.pow(1.5, state.reconnectAttempts - 1),
      10000  // Maximum delay of 10 seconds
    );
    
    log(`Scheduling reconnection attempt ${state.reconnectAttempts} in ${delay}ms`);
    
    setTimeout(async () => {
      log(`Executing reconnection attempt ${state.reconnectAttempts}`);
      
      try {
        // Ensure handshake message is in the queue
        ensureHandshakeInQueue();
        
        // Attempt reconnection
        const success = await createConnection(true);
        
        if (success) {
          log('Reconnection successful');
          state.reconnecting = false;
        } else if (state.reconnectAttempts < config.maxReconnectAttempts) {
          // Schedule another attempt
          state.reconnecting = false;  // Reset to allow a new reconnection attempt
          startReconnection();
        } else {
          log('Reconnection failed, maximum attempts reached');
          state.reconnecting = false;
          writeErrorMessage(`Failed to reconnect after ${config.maxReconnectAttempts} attempts`);
        }
      } catch (error) {
        log(`Error during reconnection: ${error.message}`);
        if (state.reconnectAttempts < config.maxReconnectAttempts) {
          // Schedule another attempt
          state.reconnecting = false;  // Reset to allow a new reconnection attempt
          startReconnection();
        } else {
          log('Reconnection failed, maximum attempts reached');
          state.reconnecting = false;
          writeErrorMessage(`Failed to reconnect after ${config.maxReconnectAttempts} attempts: ${error.message}`);
        }
      }
    }, delay);
  }
  
  /**
   * Ensure the handshake message is at the front of the queue
   */
  function ensureHandshakeInQueue() {
    // Check if handshake is already in the queue
    const handshakeIndex = state.messageQueue.findIndex(msg => 
      msg.method === "initialize" && msg.id === 0
    );
    
    if (handshakeIndex >= 0) {
      // If it exists but isn't at the front, move it
      if (handshakeIndex > 0) {
        log('Moving handshake message to front of queue');
        const handshake = state.messageQueue.splice(handshakeIndex, 1)[0];
        state.messageQueue.unshift(handshake);
      } else {
        log('Handshake message already at front of queue');
      }
    } else {
      // If it doesn't exist, add it
      log('Adding handshake message to front of queue');
      state.messageQueue.unshift({...handshakeMessage});
    }
  }
  
  // ===== Message Handling =====
  
  /**
   * Process and send client messages to the server
   */
  async function handleRequestMessage(transport, message, thisRequestId) {
    // If transport is not ready, queue the message
    if (!state.transportReady) {
      if (!thisRequestId) {
        log(`Transport not ready, skipping message`);
      } else {
        log(`Transport not ready, queuing message ID: ${thisRequestId}`);
        state.messageQueue.push(message);
      }
      return;
    }
    
    // Otherwise send immediately
    try {
      await transport.send(message);
    } catch (error) {
      log(`Error sending message ID: ${thisRequestId}: ${error.message}`);
      
      // Check if this is a fatal connection error
      if (isFatalConnectionError(error)) {
        log('Fatal connection error detected, triggering full reconnection');
        state.transportReady = false;
        state.messageQueue.push(message);
        startReconnection();
      } else {
        // Non-fatal error, just requeue the message
        state.transportReady = false;
        state.messageQueue.push(message);
        log(`(requeued) Error sending message ID: ${thisRequestId}: ${error.message}`);
      }
    }
  }
  
  /**
   * Handle incoming messages from the server
   */
  function handleResponseMessage(transport, jsonData) {
    // Only set transport as ready if this is not an error message
    if (!state.transportReady && (!jsonData.error || Object.keys(jsonData.error || {}).length === 0)) {
      log(`EventSource received message before ready, marking transport as ready`);
      state.transportReady = true;
      processQueue(transport);
    }
    
    // Format as proper JSON-RPC message for stdout
    process.stdout.write(JSON.stringify(jsonData) + '\n');
    
    // Log appropriate debug info based on message type
    if ('id' in jsonData && 'result' in jsonData) {
      log(`EventSource received response for request ID: ${jsonData.id}${jsonData.result ? ' (type: ' + (typeof jsonData.result === 'object' ? 'object' : typeof jsonData.result) + ')' : ''}`);
    } else if ('id' in jsonData && 'error' in jsonData) {
      log(`EventSource received error for request ID: ${jsonData.id}: ${jsonData.error.message}`);
      
      // If the error indicates a session issue, trigger reconnection
      if (jsonData.error.message && (
          jsonData.error.message.includes('Could not find session') ||
          jsonData.error.message.includes('Session expired') ||
          jsonData.error.message.includes('Invalid session')
      )) {
        log('Server reported session error, triggering reconnection');
        state.transportReady = false;
        startReconnection();
      } else {
        // For other errors, send cancellation notification to stdout
        const cancelNotification = {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: {
            id: jsonData.id,
            reason: `Error: ${jsonData.error.message || 'Unknown error'}`
          }
        };
        process.stdout.write(JSON.stringify(cancelNotification) + '\n');
      }
    } else if ('method' in jsonData) {
      log(`EventSource received method call: ${jsonData.method}`);
    }
  }
  
  /**
   * Process the message queue
   */
  async function processQueue(transport) {
    log(`Processing message queue (${state.messageQueue.length} messages)`);
    
    // Process all queued messages in order
    while (state.messageQueue.length > 0) {
      const message = state.messageQueue.shift();
      log(`Sending queued message ID: ${message.id || 'notification'}`);
      
      try {
        await transport.send(message);
      } catch (error) {
        log(`Error sending queued message: ${error.message}`);
        
        // Check if this is a fatal connection error
        if (isFatalConnectionError(error)) {
          // Put message back in queue
          state.messageQueue.unshift(message);
          state.transportReady = false;
          
          // Trigger reconnection
          log('Fatal connection error detected during queue processing, triggering full reconnection');
          startReconnection();
          break;
        } else {
          // Non-fatal error, just requeue and continue
          state.transportReady = false;
          state.messageQueue.unshift(message);
          break;
        }
      }
    }
  }
  
  // ===== Transport Management =====
  
  /**
   * Set up and debug the transport
   */
  function debugTransport(transport) {
    // Add a monitor for the _eventSource that will be created during start()
    const originalStartFn = transport.start;
    transport.start = async function() {
      log('Transport starting...');
      try {
        const result = await originalStartFn.apply(this, arguments);
        
        // After start completes, _eventSource should be available
        if (transport._eventSource) {
          log('EventSource created - connection starting');
          
          // IMPORTANT: Add event handler for the 'open' event to mark transport as ready
          transport._eventSource.onopen = () => {
            log('EventSource connection opened');
            // Note: We don't mark transport as ready here - we wait for the endpoint
            // This is important because we need both GET and POST connections
          };
          
          // Add explicit error handler to detect early connection issues
          const originalOnError = transport._eventSource.onerror;
          transport._eventSource.onerror = (err) => {
            log(`EventSource error: ${err.type}`);
            
            // Only react to errors if we're not already handling them
            if (!state.reconnecting && transport._eventSource && transport._eventSource.readyState === 2) { // CLOSED
              log('EventSource connection closed due to error');
              state.transportReady = false;
              startReconnection();
            }
            
            // Call the original error handler if it exists
            if (originalOnError) {
              originalOnError(err);
            }
          };
          
          // Add explicit handler for the endpoint event
          transport._eventSource.addEventListener("endpoint", (event) => {
            try {
              log('Received endpoint event from server');
              // Now that we have an endpoint, we can mark the transport as ready
              if (!state.transportReady) {
                log('Marking transport as ready after receiving endpoint');
                state.transportReady = true;
                
                // Ensure handshake message is prioritized
                ensureHandshakeInQueue();
                
                // Process queue in case any messages were queued before connection was ready
                if (state.messageQueue.length > 0) {
                  processQueue(transport);
                }
              }
            } catch (error) {
              log(`Error processing endpoint event: ${error.message}`);
            }
          });
          
          // Insert our raw event handler
          const originalESOnMessage = transport._eventSource.onmessage;
          transport._eventSource.onmessage = (event) => {
            try {
              let jsonData;
              if (Buffer.isBuffer(event.data)) {
                // If it's a buffer, convert to string first
                const dataStr = event.data.toString('utf8');
                jsonData = JSON.parse(dataStr);
              } else if (typeof event.data === 'string') {
                // Parse string data
                jsonData = JSON.parse(event.data);
              } else {
                // If it's already an object
                jsonData = event.data;
              }
              
              // Use the response message handler to process the message
              handleResponseMessage(transport, jsonData);
              
              // Still call original handler
              if (originalESOnMessage) {
                originalESOnMessage(event);
              }
            } catch (err) {
              // If we can't parse the event data, send a connection closed error
              log(`Error parsing event data: ${err.message}`);
              writeErrorMessage(`EventSource connection error: ${err.message}`, {}, -32000);
            }
          };
        }
        
        return result;
      } catch (error) {
        log(`Error in transport.start(): ${error.message}`);
        throw error;
      }
    };

    return transport;
  }
  
  // ===== Lifecycle Management =====
  
  /**
   * Graceful shutdown
   */
  async function shutdown() {
    log('Gracefully shutting down...');
    
    try {
      // Clean up readline interface
      if (state.readline) {
        state.readline.close();
      }
      
      // Close the client connection and wait for it to complete
      if (state.client) {
        log('Closing client connection...');
        
        try {
          // Send a cancellation notification before closing
          const transport = state.client.transport;
          if (transport) {
            log('Sending shutdown notification...');
            await transport.send({
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: {
                reason: "Client shutting down"
              }
            });
            log('Shutdown notification sent.');
            // Small delay to allow the server to process the notification
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        } catch (error) {
          log(`Error sending shutdown notification: ${error.message}`);
          writeErrorMessage(error, {}, -32000);
        }
        
        // Now close the client
        await state.client.close();
        log('Client connection closed.');
      }
      
      log('Shutdown complete.');
      process.exit(0);
    } catch (error) {
      log(`Error during shutdown: ${error.message}`);
      writeErrorMessage(error, {}, -32000);
      process.exit(1);
    }
  }
  
  /**
   * Setup stdin handling for message input
   */
  function setupStdinHandler() {
    // Create a readline interface to read from stdin
    state.readline = createInterface({
      input: process.stdin,
      terminal: false
    });
    
    // Handle input from stdin
    state.readline.on('line', async (line) => {
      if (line.trim()) {
        let thisRequestId = null;
        try {
          // Parse the message to ensure it's valid JSON
          const message = JSON.parse(line);
          
          // Store the request ID for potential error handling
          if (message.id !== undefined) {
            log(`Tracking request ID: ${message.id}${message.method ? ', method: ' + message.method : ''}`);
            thisRequestId = message.id;
          } else if (message.method) {
            log(`Processing notification method: ${message.method}`);
            if (message.method === "notifications/cancelled") {
              const params = message.params;
              const requestId = params.requestId;
              log(`Received cancellation notification: requestId: ${requestId}, reason: ${params.reason}`);
              state.messageQueue = state.messageQueue.filter(m => m.id !== requestId);
            }
          }
          
          // Use the message handler instead of sending directly
          await handleRequestMessage(state.transport, message, thisRequestId);
        } catch (error) {
          log(`Error processing stdin message: ${error.message}`);
          log(`Raw input: ${line}`);
          
          // Check if this is a connection error
          if (isFatalConnectionError(error)) {
            log('Connection error detected, notifying client');
            writeErrorMessage(`Connection lost, client should reconnect: ${error.message}`, {}, -32000, thisRequestId);
            state.transportReady = false;
            startReconnection();
          }
          
          if (error.stack) {
            log(`Error stack: ${error.stack}`);
          }
        }
      }
    });
  }
  
  // Public API
  return {
    /**
     * Start the MCP client bridge
     */
    start: function(url) {
      // Process URL argument
      if (!url) {
        console.error('[mcpgate] Error: No URL provided.');
        console.error('[mcpgate] Usage: mcpgate <url>');
        console.error('[mcpgate] Example: mcpgate http://example.com:8000/sse');
        process.exit(1);
      }
      
      // Initialize configuration
      config.url = url;
      config.sessionId = randomUUID();
      
      // Setup signal handlers for graceful shutdown
      process.on('SIGINT', () => {
        shutdown().catch(error => {
          log(`Failed to shut down gracefully: ${error.message}`);
          process.exit(1);
        });
      });
      
      process.on('SIGTERM', () => {
        shutdown().catch(error => {
          log(`Failed to shut down gracefully: ${error.message}`);
          process.exit(1);
        });
      });
      
      // Setup stdin handler for message input
      setupStdinHandler();
      
      // Initialize and connect
      return createConnection(false).catch(error => {
        log(`Fatal error: ${error.message}`);
        if (error.stack) {
          log(`Error stack: ${error.stack}`);
        }
        process.exit(1);
      });
    }
  };
})();

// Process command line arguments
const url = process.argv[2];

// Start the MCP client bridge
MCPGate.start(url);