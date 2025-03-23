#!/usr/bin/env node

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory of the script
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Add color to console output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

// Specific file to watch
const fileToWatch = path.join(__dirname, 'index.js');
let lastHash = '';

const interval = 10000;

console.log(`${colors.cyan}🔍 Watching index.js for changes (checking every ${interval / 1000} seconds)...${colors.reset}`);
console.log(`${colors.yellow}Press Ctrl+C to exit${colors.reset}`);

// Function to calculate file hash
function getFileHash(filePath) {
  try {
    const content = readFileSync(filePath, 'utf8');
    return createHash('md5').update(content).digest('hex');
  } catch (error) {
    console.log(`${colors.red}Error reading file: ${error.message}${colors.reset}`);
    return '';
  }
}

// Initialize hash on startup
lastHash = getFileHash(fileToWatch);

// Function to reinstall package
function reinstallPackage() {
  console.log(`${colors.yellow}📦 Change detected in index.js! Reinstalling package...${colors.reset}`);
  
  // Using npm to install the package globally from the current directory
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const install = spawn(npm, ['install', '-g', '.'], { cwd: __dirname });
  
  install.stdout.on('data', (data) => {
    console.log(`${colors.green}${data.toString().trim()}${colors.reset}`);
  });
  
  install.stderr.on('data', (data) => {
    console.log(`${colors.red}${data.toString().trim()}${colors.reset}`);
  });
  
  install.on('close', (code) => {
    if (code === 0) {
      console.log(`${colors.green}✅ Package reinstalled successfully!${colors.reset}`);
      console.log(`${colors.cyan}🔍 Watching index.js for changes (checking every 30 seconds)...${colors.reset}`);
    } else {
      console.log(`${colors.red}❌ Failed to reinstall package (exit code: ${code})${colors.reset}`);
    }
  });
}

// Check for changes every 30 seconds
setInterval(() => {
  const currentHash = getFileHash(fileToWatch);
  
  if (currentHash && lastHash !== currentHash) {
    console.log(`${colors.blue}🔄 File index.js changed (hash: ${currentHash.substring(0, 8)})${colors.reset}`);
    lastHash = currentHash;
    reinstallPackage();
  }
}, interval);