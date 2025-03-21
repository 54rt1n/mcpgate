#!/usr/bin/env node

/**
 * MCP SDK Client Bridge (sdk-client.js)
 * ------------------------------
 * This script:
 * 1. Uses the official Model Context Protocol SDK
 * 2. Creates a client with SSE transport
 * 3. Reads messages from stdin and forwards them to the MCP server
 * 4. Receives messages from the MCP server and forwards them to stdout
 * 5. Provides a bridge between command-line tools and the MCP protocol
 */

import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

// Process command line arguments
const url = process.argv[2];
if (!url) {
  console.error('[mcpgate] Error: No URL provided.');
  console.error('[mcpgate] Usage: mcpgate <url>');
  console.error('[mcpgate] Example: mcpgate http://example.com:8000/sse');
  process.exit(1);
}

// Generate a unique session ID for this client
let sessionId = randomUUID();

// Log to stderr so we don't interfere with the stdout message channel
console.error('[mcpgate] Starting SDK client...');
console.error(`[mcpgate] URL: ${url}`);
console.error(`[mcpgate] Session ID: ${sessionId}`);

// Create a readline interface to read from stdin
const readline = createInterface({
  input: process.stdin,
  terminal: false
});

function writeErrorMessage(message, data, code = -32000, id = undefined) {
  // We need to write out a JSON-RPC error message to stdout
  const myMessage = typeof message === 'string' ? message : (message && message.message ? message.message : 'Unknown error');
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: {
      code: code,
      message: myMessage,
      data: data
    }
  }) + '\n');
}

// Global client reference for shutdown
let client = null;

// Message queue for messages received before transport is ready
let messageQueue = [];
let transportReady = false;

// Function to handle outgoing messages (client to server) with proper queuing
async function handleRequestMessage(transport, message, thisRequestId) {
  // If transport is not ready, queue the message
  if (!transportReady) {
    console.error(`[mcpgate] Transport not ready, queuing message ID: ${thisRequestId || 'none'}`);
    messageQueue.push(message);
    return;
  }
  
  // Otherwise send immediately
  try {
    await transport.send(message);
  } catch (error) {
    console.error(`[mcpgate] Error sending message ID: ${thisRequestId}: ${error.message}`);
    throw error;
  }
}

// Function to handle incoming messages (server to client)
function handleResponseMessage(transport, jsonData) {
  // Check if this is the first message - if so, ensure transport is ready
  // This is a fallback in case the onopen event wasn't triggered
  if (!transportReady) {
    console.error(`[mcpgate] EventSource received message before ready, marking transport as ready`);
    transportReady = true;
    processQueue(transport);
  }
  
  // Format as proper JSON-RPC message for stdout
  process.stdout.write(JSON.stringify(jsonData) + '\n');
  
  // Log appropriate debug info based on message type
  if ('id' in jsonData && 'result' in jsonData) {
    console.error(`[mcpgate] EventSource received response for request ID: ${jsonData.id}${jsonData.result ? ' (type: ' + (typeof jsonData.result === 'object' ? 'object' : typeof jsonData.result) + ')' : ''}`);
  } else if ('id' in jsonData && 'error' in jsonData) {
    console.error(`[mcpgate] EventSource received error for request ID: ${jsonData.id}: ${jsonData.error.message}`);
    const cancelNotification = {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: {
        id: jsonData.id,
        reason: `Error: ${jsonData.error.message || 'Unknown error'}`
      }
    };
    process.stdout.write(JSON.stringify(cancelNotification) + '\n');
  } else if ('method' in jsonData) {
    console.error(`[mcpgate] EventSource received method call: ${jsonData.method}`);
  }
}

// Function to process queued messages
async function processQueue(transport) {
  console.error(`[mcpgate] Processing message queue (${messageQueue.length} messages)`);
  
  // Process all queued messages in order
  while (messageQueue.length > 0) {
    const message = messageQueue.shift();
    console.error(`[mcpgate] Sending queued message ID: ${message.id || 'notification'}`);
    
    try {
      await transport.send(message);
    } catch (error) {
      console.error(`[mcpgate] Error sending queued message: ${error.message}`);
      if (message.id) {
        writeErrorMessage(`Failed to send queued request: ${error.message}`, null, -32000, message.id);
      }
      // Don't rethrow, continue processing queue
    }
  }
}

// Debug helper function
function debugTransport(transport) {
  // Add a monitor for the _eventSource that will be created during start()
  const originalStartFn = transport.start;
  transport.start = async function() {
    console.error('[mcpgate] Transport starting...');
    const result = await originalStartFn.apply(this, arguments);
    
    // After start completes, _eventSource should be available
    if (transport._eventSource) {
      console.error('[mcpgate] EventSource created - connection starting');
      
      // IMPORTANT: Add event handler for the 'open' event to mark transport as ready
      // This happens before any messages are exchanged
      transport._eventSource.onopen = () => {
        console.error('[mcpgate] EventSource connection opened');
        // Mark transport as ready as soon as the connection opens
        // This is before any SDK-generated messages are sent
        if (!transportReady) {
          console.error('[mcpgate] Marking transport as ready on connection open');
          transportReady = true;
          // Process queue in case any messages were queued before connection was ready
          if (messageQueue.length > 0) {
            processQueue(transport);
          }
        }
      };
      
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
          writeErrorMessage(`EventSource connection error: ${err.message}`, {}, -32000);
        }
      };
    }
    
    return result;
  };

  // Also wrap Client.connect to log SDK-generated messages
  const originalClientConnect = Client.prototype.connect;
  Client.prototype.connect = async function(transport) {
    console.error('[mcpgate] Client connect starting - SDK may auto-generate messages after this');
    const result = await originalClientConnect.apply(this, arguments);
    console.error('[mcpgate] Client connect completed');
    return result;
  };

  return transport;
}

// Graceful shutdown function
async function shutdown() {
  console.error('[mcpgate] Gracefully shutting down...');
  
  try {
    // Clean up readline interface
    readline.close();
    
    // Close the client connection and wait for it to complete
    if (client) {
      console.error('[mcpgate] Closing client connection...');
      
      try {
        // Send a cancellation notification before closing
        // This helps the server understand the client is intentionally disconnecting
        const transport = client.transport;
        if (transport) {
          console.error('[mcpgate] Sending shutdown notification...');
          await transport.send({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: {
              reason: "Client shutting down"
            }
          });
          console.error('[mcpgate] Shutdown notification sent.');
          // Small delay to allow the server to process the notification
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (error) {
        console.error(`[mcpgate] Error sending shutdown notification: ${error.message}`);
        writeErrorMessage(error, {}, -32000);
      }
      
      // Now close the client
      await client.close();
      console.error('[mcpgate] Client connection closed.');
    }
    
    console.error('[mcpgate] Shutdown complete.');
    process.exit(0);
  } catch (error) {
    console.error(`[mcpgate] Error during shutdown: ${error.message}`);
    writeErrorMessage(error, {}, -32000);
    process.exit(1);
  }
}

async function main() {
  try {
    // Create the SSE transport with the session ID in the URL
    const sseUrl = new URL(url);
    sseUrl.searchParams.append('session_id', sessionId);
    
    // Create the transport with custom init options
    const transport = new SSEClientTransport(sseUrl);
    console.error('[mcpgate] Transport created');
    
    // Add debug wrappers
    debugTransport(transport);
    
    // Add custom error handler for the transport
    transport.onerror = (error) => {
      console.error(`[mcpgate] Transport error: ${error.message}`);
      
      // Log connection state without modifying behavior
      if (transport._eventSource) {
        console.error(`[mcpgate] EventSource state: ${transport._eventSource.readyState}`);
      }
      
      // Signal connection closed to the client using our helper function
      writeErrorMessage(`SSE connection error, client should reconnect: ${error.message}`);
    };
    
    // Forward all messages from the server to stdout
    // Since our transport already writes to stdout, we don't need to do anything here, just track the messages
    transport.onmessage = (message) => {
      // Output raw message to stdout for the caller to consume
      console.error(`[mcpgate] Wrote message to stdout: ${JSON.stringify(message).substring(0, 150)}${JSON.stringify(message).length > 150 ? '...' : ''}`);
      
      // Track responses for debugging
      if ('id' in message && 'result' in message) {
        console.error(`[mcpgate] Received response for request ID: ${message.id}`);
      } else if ('method' in message) {
        console.error(`[mcpgate] Received method call: ${message.method}`);
      } else if ('id' in message && 'error' in message) {
        console.error(`[mcpgate] Received error for request ID: ${message.id}: ${message.error.message}`);
      }
    };
    
    // Reset message queue and transport ready state before connecting
    messageQueue = [];
    transportReady = false;
    
    // Handle input from stdin
    readline.on('line', async (line) => {
      if (line.trim()) {
        let thisRequestId = null;
        try {
          // Parse the message to ensure it's valid JSON
          const message = JSON.parse(line);
          
          // Store the request ID for potential error handling
          if (message.id !== undefined) {
            console.error(`[mcpgate] Tracking request ID: ${message.id}${message.method ? ', method: ' + message.method : ''}`);
            thisRequestId = message.id;
          } else if (message.method) {
            console.error(`[mcpgate] Processing notification method: ${message.method}`);
          }
          
          // Use the message handler instead of sending directly
          await handleRequestMessage(transport, message, thisRequestId);
        } catch (error) {
          console.error(`[mcpgate] Error processing stdin message: ${error.message}`);
          console.error(`[mcpgate] Raw input: ${line}`);
          
          // Check if this is a connection error
          if (error.message && (
              error.message.includes('Not connected') || 
              error.message.includes('fetch failed') ||
              error.message.includes('network error'))) {
            
            console.error('[mcpgate] Connection error detected, notifying client');
            writeErrorMessage(`Connection lost, client should reconnect: ${error.message}`, {}, -32000, thisRequestId);
          }
          
          if (error.stack) {
            console.error(`[mcpgate] Error stack: ${error.stack}`);
          }
        }
      }
    });
    
    // Handle graceful shutdown
    process.on('SIGINT', () => {
      shutdown().catch(error => {
        console.error(`[mcpgate] Failed to shut down gracefully: ${error.message}`);
        process.exit(1);
      });
    });
    
    process.on('SIGTERM', () => {
      shutdown().catch(error => {
        console.error(`[mcpgate] Failed to shut down gracefully: ${error.message}`);
        process.exit(1);
      });
    });

    // Create the client with minimal info
    client = new Client({
      name: 'mcpgate',
      version: '1.0.0',
    });
    
    // Connect to the server
    console.error('[mcpgate] Connecting to server...');
    await client.connect(transport);
    console.error('[mcpgate] Connected successfully');
  } catch (error) {
    console.error(`[mcpgate] Error: ${error.message}`);
    if (error.stack) {
      console.error(`[mcpgate] Error stack: ${error.stack}`);
    }
    writeErrorMessage(error);
    process.exit(1);
  }
}

main().catch(error => {
  console.error(`[mcpgate] Fatal error: ${error.message}`);
  if (error.stack) {
    console.error(`[mcpgate] Error stack: ${error.stack}`);
  }
  process.exit(1);
});