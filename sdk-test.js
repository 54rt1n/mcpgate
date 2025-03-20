#!/usr/bin/env node

/**
 * MCP SDK Client Test (sdk-test.js)
 * ------------------------------
 * This script:
 * 1. Spawns the mcpgate process
 * 2. Waits for the client to automatically initialize
 * 3. Sends test requests (ping, tools/list, prompts/list)
 * 4. Executes several tools with the tools/call method
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';

// URL to connect to
const url = process.argv[2] || 'http://localhost:8000/sse';

console.log('Starting MCPGATE client test...');
console.log(`URL: ${url}`);

// Spawn the SDK client process
const clientProcess = spawn('node', ['index.js', url], {
  stdio: ['pipe', 'pipe', 'pipe'] // Capture stderr as well
});

// Create a readline interface to read stdout of the client
const rl = createInterface({
  input: clientProcess.stdout,
  terminal: false
});

// Track connection status
let connectionReady = false;
let testFinished = false;
let currentRequestId = 1;

// Helper function to get next request ID
function getNextRequestId() {
  return currentRequestId++;
}

function handleRequest(request, resolve, reject) {
  const t = setTimeout(() => {
    reject(new Error('Request timed out'));
  }, 2000);
  clientProcess.stdout.on('data', (data) => {
    clearTimeout(t);
    // console.log('Response:', data);
    clientProcess.stdout.removeAllListeners('data');
    const response = JSON.parse(data);
    resolve(response);
  });
  clientProcess.stdin.write(JSON.stringify(request) + '\n');
}

// Send requests in sequence
function sendPingRequest() {
  return new Promise((resolve, reject) => {
    console.log('Client connected! Sending test requests...');
    
    // Send ping request
    const pingRequest = {
      jsonrpc: '2.0',
      id: getNextRequestId(),
      method: 'ping'
    };
    
    console.log('\nSending ping request...');
    handleRequest(pingRequest, resolve, reject);
  });
}

function sendListToolsRequest() {
  return new Promise((resolve, reject) => {
    const listToolsRequest = {
        jsonrpc: '2.0',
        id: getNextRequestId(),
        method: 'tools/list',
        params: {}
    };

    console.log('\nSending tools/list request...');
    handleRequest(listToolsRequest, resolve, reject);
  });
}

async function sendCallToolRequest(name, params) {
  return new Promise((resolve, reject) => {
    const callToolRequest = {
      jsonrpc: '2.0',
      id: getNextRequestId(),
      method: 'tools/call',
      params: { name, arguments: params }
    };

    console.log(`\nSending tool call request for '${name}' with params:`, params);
    handleRequest(callToolRequest, resolve, reject);
  });
}

async function executeToolCalls() {
  console.log('\nExecuting tool calls...');
  
  // Queue up tool calls to execute
  const pendingToolCalls = [
    { name: 'file_list', params: { path: '/' } },
    { name: 'system_env_var', params: {} },
    { name: 'web_search', params: { query: 'Model Context Protocol' } }
  ];

  const results = [];

  for (const call of pendingToolCalls) {
    const result = await sendCallToolRequest(call.name, call.params);
    console.log('Tool call result:', result);
    results.push(result);
  }

  return results;
}

async function sendRequests() {
  const pingResponse = await sendPingRequest();
  console.log('Ping response:', pingResponse);
  const toolsListResponse = await sendListToolsRequest();
  console.log('Tools list response:', toolsListResponse);
  const results = await executeToolCalls();
}

// Echo stderr output for debugging
clientProcess.stderr.on('data', (data) => {
  const stderr = data.toString();
  
  // Filter mcpgate debug messages - only show ones
  // if (stderr.includes('[mcpgate] Error:') || 
  //     stderr.includes('[mcpgate] Fatal error:') || 
  //     stderr.includes('[mcpgate] Connected successfully') ||
  //     stderr.includes('[mcpgate] Shutting down')) {
  //   process.stderr.write(stderr);
  // }
  
  if (stderr.includes('[mcpgate] Connected successfully') && !connectionReady) {
    connectionReady = true;
    // Wait a moment to ensure initialization is complete
    sendRequests().then(() => {
      console.log('All requests sent successfully');
      testFinished = true;
      gracefulShutdown();
    }, error => {
      console.error('Error sending requests:', error);
    });
  }
});

// Gracefully shut down the client process
function gracefulShutdown() {
  console.log('\nTest complete. Gracefully shutting down...');
  clearInterval(checkInterval);
  
  // Send SIGTERM to allow the client to shut down gracefully
  // console.log('Sending SIGTERM to client process...');
  clientProcess.kill('SIGTERM');
  
  // Set a fallback timeout in case graceful shutdown fails
  setTimeout(() => {
    if (clientProcess.killed) {
      // console.log('Client process was already terminated.');
    } else {
      console.log('Forcing client process termination.');
      clientProcess.kill('SIGKILL');
    }
    process.exit(0);
  }, 100);
}

// Also handle our own process termination
process.on('SIGTERM', () => {
  console.log('Received SIGTERM. Shutting down child process...');
  gracefulShutdown();
});

// Check periodically if we're done
const checkInterval = setInterval(() => {
  if (testFinished) {
    gracefulShutdown();
  }
}, 1000);

// Set a maximum timeout
setTimeout(() => {
  if (!connectionReady) {
    console.log('\nNo connection established. This could be due to:');
    console.log('1. Authentication requirements');
    console.log('2. Server configuration issues');
    console.log('3. Connection problems');
  }
  
  console.log('\nTest timed out. Shutting down...');
  gracefulShutdown();
}, 45000);