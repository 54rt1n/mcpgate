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

let lastRequestId = null;

function writeErrorMessage(message, data, code = -9001) {
  // We need to write out a JSON-RPC error message to stdout
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: lastRequestId ?? 0,
    error: {
      code: code,
      message: message,
      data: data
    }
  }) + '\n');
}

// Global client reference for shutdown
let client = null;

// Debug helper function
function debugTransport(transport) {
  const originalStart = transport.start.bind(transport);
  transport.start = async function() {
    try {
      await originalStart();
      
      // Now that start() has completed, the _eventSource should be created
      if (transport._eventSource) {
        const originalEventSourceOnMessage = transport._eventSource.onmessage;
        transport._eventSource.onmessage = (event) => {
          // Call the original handler if it exists
          if (originalEventSourceOnMessage) {
            originalEventSourceOnMessage(event);
          }
        };
      }
    } catch (error) {
      writeErrorMessage(error);
      throw error;
    }
  };

  const originalSend = transport.send.bind(transport);
  transport.send = async function(message) {
    try {
      await originalSend(message);
    } catch (error) {
      // If this is a request (has an ID), generate an appropriate error response
      if (message.id) {
        const errorResponse = {
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32003,
            message: `Failed to send request: ${error.message}`,
          }
        };
        process.stdout.write(JSON.stringify(errorResponse) + '\n');
      }
      
      writeErrorMessage(error);
      throw error;
    }
  };

  // Hook into the onmessage callback - this is a proper public interface
  const originalOnmessage = transport.onmessage;
  transport.onmessage = (message) => {
    if (originalOnmessage) {
      originalOnmessage(message);
    }
  };
  
  // Add a monitor for the _eventSource that will be created during start()
  const originalStartFn = transport.start;
  transport.start = async function() {
    // console.error('[mcpgate] Overriding start to ensure EventSource capture');
    const result = await originalStartFn.apply(this, arguments);
    
    // After start completes, _eventSource should be available
    if (transport._eventSource) {
      // console.error('[mcpgate] Adding direct event handler after start');
      
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
          
          // Format as proper JSON-RPC message
          process.stdout.write(JSON.stringify(jsonData) + '\n');
          
          // Create cancellation notification if needed
          if (jsonData.error) {
            const cancelNotification = {
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: {
                requestId: jsonData.id,
                reason: `Error: ${jsonData.error.message || 'Unknown error'}`
              }
            };
            process.stdout.write(JSON.stringify(cancelNotification) + '\n');
          }
          
          // Still call original handler
          if (originalESOnMessage) {
            originalESOnMessage(event);
          }
        } catch (err) {
          writeErrorMessage(err);
        }
      };
    }
    
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
        writeErrorMessage(error);
      }
      
      // Now close the client
      await client.close();
      console.error('[mcpgate] Client connection closed.');
    }
    
    console.error('[mcpgate] Shutdown complete.');
    process.exit(0);
  } catch (error) {
    console.error(`[mcpgate] Error during shutdown: ${error.message}`);
    writeErrorMessage(error);
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
    
    // Create the client with minimal info
    client = new Client({
      name: 'mcpgate',
      version: '1.0.0',
    });
    
    // Forward all messages from the server to stdout
    // This overwrites the default client handler but that's what we want
    transport.onmessage = (message) => {
      // Output raw message to stdout for the caller to consume
      console.error(`[mcpgate] Writing message to stdout: ${JSON.stringify(message)}`);
      process.stdout.write(JSON.stringify(message) + '\n');
    };
    
    // Connect to the server
    console.error('[mcpgate] Connecting to server...');
    await client.connect(transport);
    console.error('[mcpgate] Connected successfully');
    
    // Handle input from stdin
    readline.on('line', async (line) => {
      if (line.trim()) {
        try {
          // Parse the message to ensure it's valid JSON
          const message = JSON.parse(line);
          
          // Send the raw message directly through the transport
          await transport.send(message);
        } catch (error) {
          console.error(`[mcpgate] Error processing stdin message: ${error.message}`);
          console.error(`[mcpgate] Raw input: ${line}`);
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