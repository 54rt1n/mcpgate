When trying to get it to run on cursor in windows, this configuration was successful:

```json
{
  "mcpServers": {
    "cloud": {
      "command": "C:\\PROGRA~1\\nodejs\\node.exe",
      "args": [
        "C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\mcpgate\\index.js",
        "http://10.1.0.101:8000/sse"
      ]
    }
  }
}
```

I had to use the shortened path, and npx does not seem to be available from their app jail.