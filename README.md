# MCPGate

A robust and resilient stdio-to-HTTP bridge for MCP (Model Context Protocol) connections with advanced reconnection handling.

![MCPGate Banner](assets/mcpgate-banner.svg)

## Description

MCPGate creates a bidirectional bridge between standard I/O and HTTP, enabling any application that communicates via stdin/stdout to interact with remote MCP servers:

1. Reads JSON-RPC messages from stdin
2. Forwards them as HTTP POST requests to the specified MCP endpoint
3. Receives responses via SSE (Server-Sent Events) from the same endpoint
4. Forwards responses back to stdout

## Key Features

- **Resilient Bidirectional Communication** - Maintains stable connections between stdin/stdout and HTTP/SSE
- **Advanced Reconnection Handling** - Automatically recovers from network interruptions and session timeouts
- **Intelligent Session Management** - Preserves session state where possible, with graceful fallback strategies
- **Message Queuing** - Ensures no messages are lost during connection interruptions
- **Comprehensive Error Handling** - Classifies errors and applies appropriate recovery strategies
- **Clean Module Architecture** - Well-structured codebase with clear separation of concerns

## Requirements

- Node.js 16.x or higher
- NPM package manager

## Installation

### Local Installation

```bash
# Clone the repository
git clone https://github.com/username/mcpgate.git
cd mcpgate

# Install dependencies
npm install
```

### Global Installation

```bash
# Install globally from the project directory
npm install -g .

# Or install directly from npm (when published)
npm install -g mcpgate
```

## Usage

### Basic Usage

```bash
# Run with Node directly
node index.js http://example.com:8000/sse

# After global installation
mcpgate http://example.com:8000/sse

# Via npx without installation
npx mcpgate http://example.com:8000/sse
```

### Command Line Options

```
mcpgate <url> [options]

Arguments:
  url                    The URL of the MCP server endpoint (required)

Options:
  --debug                Enable detailed debug logging (default: true)
  --reconnect-delay      Base delay for reconnection in ms (default: 1000)
  --max-reconnects       Maximum reconnection attempts (default: 5)
```

### Using with an MCP Client

MCP clients such as Claude Desktop can be configured to use MCPGate as a bridge to connect to HTTP-based MCP servers:

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

## How It Works

MCPGate creates a bidirectional bridge between local applications and remote MCP servers:

1. **Connection Establishment**:
   - Creates an SSE connection for receiving server messages
   - Receives the endpoint URL for sending messages via POST

2. **Message Flow**:
   - Reads JSON-RPC messages from stdin
   - Queues messages if the connection isn't ready
   - Sends messages to the MCP server via HTTP POST
   - Receives responses via SSE and forwards to stdout

3. **Reconnection Strategy**:
   - Detects connection failures through various error patterns
   - Implements exponential backoff for reconnection attempts
   - Preserves the original session ID for initial reconnection attempts
   - Falls back to a new session ID after multiple failures
   - Properly re-executes handshake sequence after reconnection

4. **Error Handling**:
   - Classifies errors as fatal or recoverable
   - Applies appropriate recovery strategies based on error type
   - Ensures all queued messages are preserved during reconnection
   - Provides detailed logging for troubleshooting

## Advanced Features

### Session Management

MCPGate intelligently manages session persistence:

- Uses a unique session ID for each connection
- Attempts to preserve the session across disconnections
- Falls back to creating a new session after multiple failed reconnection attempts
- Properly handles the full handshake sequence required by the MCP protocol

### Message Queuing

Messages are never lost, even during connection interruptions:

- Automatically queues messages when the connection isn't ready
- Prioritizes the handshake message after reconnection
- Preserves message order during reconnection events
- Resumes message processing once connection is re-established

### Error Classification

Not all errors are equal - MCPGate intelligently handles different error types:

- **Fatal errors** (connection lost, session expired) - Trigger full reconnection
- **Transient errors** (temporary network issues) - Result in message requeuing
- **Protocol errors** (malformed messages) - Reported clearly to the client

## Troubleshooting

All debug logs are sent to stderr to avoid interfering with the stdin/stdout communication channel:

```bash
# Save logs to a file for analysis
mcpgate http://example.com:8000/sse 2> mcpgate.log

# Filter logs for specific events
mcpgate http://example.com:8000/sse 2>&1 | grep "reconnect"
```

### Common Issues

1. **Connection Refused**
   - Ensure the MCP server is running and accessible
   - Check that the URL is correct and includes the /sse path

2. **Authentication Failures**
   - Verify that your session credentials are valid
   - Check server logs for authorization issues

3. **Frequent Disconnections**
   - May indicate network stability issues
   - Check server-side session timeout settings

## Examples

### Basic Connection

```bash
# Connect to a local MCP server
mcpgate http://localhost:8000/sse

# Connect to a remote server with a specific port
mcpgate http://api.example.com:8080/mcp/sse
```

### Integration with Other Tools

```bash
# Pipe input from a file and output to another file
cat input.json | mcpgate http://localhost:8000/sse > output.json

# Use with a custom client
my-mcp-client | mcpgate http://example.com:8000/sse | result-processor
```

## Architecture

MCPGate is built with a clean module pattern architecture:

```
MCPGate Module
├── Public API
│   └── start() - Initialize and start the bridge
└── Private Components
    ├── Connection Management - Handle transport and session lifecycle
    ├── Message Processing - Queue and send messages
    ├── Event Handling - Process SSE events
    └── Error Management - Classify and respond to errors
```

## Testing

To verify functionality:

```bash
# Run the test script with default URL
node sdk-test.js

# Specify a custom URL
node sdk-test.js http://example.com:8000/sse
```

The test script will:
1. Connect to the specified MCP server
2. Send a ping request
3. List available tools
4. Execute several tool calls

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- Martin Bukowski - Original conception and implementation
- The MCP Protocol community for standards and guidance
- Claude Sonnet 3.7 Thinking, for being an awesome model

---

*MCPGate: Bridging the gap between local applications and remote intelligence.*