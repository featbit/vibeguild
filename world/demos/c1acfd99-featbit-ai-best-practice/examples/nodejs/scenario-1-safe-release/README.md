# Scenario 1: AI Model Safe Release (Node.js)

## Overview

Node.js implementation of AI Model Safe Release using FeatBit Feature Flags.

## Setup

```bash
npm install

# Set environment variables
export FEATBIT_SDK_KEY="your-sdk-key"
export FEATBIT_STREAMING_URI="wss://app-eval.featbit.co"
export FEATBIT_EVENTS_URI="https://app-eval.featbit.co"
```

## Running

```bash
npm start
```

## Testing

```bash
# Health check
curl http://localhost:8000/api/health

# Send chat message
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"user_id": "user-001", "message": "Hello!"}'

# Check flag status
curl http://localhost:8000/api/flag-status/user-001
```
