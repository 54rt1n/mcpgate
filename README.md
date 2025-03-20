# mcpgate

A simple stdio-to-http bridge for MCP (Model Context Protocol) connections.

## Description

mcpgate connects to an HTTP endpoint and brokers MCP messages between your local application and the remote MCP server:

1. It reads JSON-RPC messages from stdin
2. Forwards them as HTTP POST requests to the specified endpoint
3. Receives responses via SSE (Server-Sent Events) from the same endpoint
4. Forwards responses to stdout

## Requirements

- Node.js 14.16 or higher
- NPM package manager

## Installation

### Local Installation

```bash
# Install dependencies
npm install
```

### Global Installation

```bash
# Install globally
npm install -g .
```

## Usage

### Via Node directly

```bash
node index.js http://example.com:8000/sse
```

### Via npx (without installation)

```bash
# Run directly from the current directory
npx . http://example.com:8000/sse

# Or install temporarily and run
npx mcpgate http://example.com:8000/sse
```

### Via Command File (Windows)

```powershell
mcpgate.cmd http://example.com/sse
```

### After Global Installation

```bash
mcpgate http://example.com:8000/sse
```

### Using mcpgate with an MCP client

MCP clients such as Claude Desktop that expect to communicate with a stdio-based MCP server can use mcpgate to connect to an HTTP-based MCP server:

```json
{
  "mcpServers": {
    "your-servername": {
      "command": "npx",
      "args": [
        "-y",
        "mcpgate",
        "\"http://example.com:8000/sse\""
      ]
    }
  }
}
```

## Testing

The project includes a test script to verify functionality:

```powershell
# Run the test script with default URL (http://localhost:8000/sse)
node sdk-test.js

# Or specify a custom URL
node sdk-test.js http://example.com:8000/sse
```

The test script will:
1. Connect to the specified MCP server
2. Send a ping request
3. List available tools
4. Execute several tool calls (file_list, system_env_var, web_search)

## Troubleshooting

All log messages are sent to stderr so they don't interfere with the stdin/stdout communication.

## Example

```bash
# Connect to an MCP server at http://10.100.0.58:8000/sse
mcpgate http://10.100.0.58:8000/sse

# Or with npx
npx mcpgate http://10.100.0.58:8000/sse
``` 

## Author

Martin Bukowski