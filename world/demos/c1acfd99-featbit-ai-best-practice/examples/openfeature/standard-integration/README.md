# OpenFeature Standard Integration

## Overview

This example demonstrates using **OpenFeature** - the open standard for feature flagging - with FeatBit as the backend provider.

## Why OpenFeature?

- **Vendor Agnostic**: Switch providers without changing code
- **Standardized API**: Consistent interface across all providers
- **Community Driven**: CNCF sandbox project
- **Future Proof**: Protects against vendor lock-in

## Installation

```bash
npm install @openfeature/server-sdk
npm install @featbit/node-server-sdk
npm install @featbit/openfeature-provider-node-server
```

## Quick Start

```javascript
const { OpenFeature } = require('@openfeature/server-sdk');
const { FbProvider } = require('@featbit/openfeature-provider-node-server');

// Set up provider
const provider = new FbProvider({
  sdkKey: 'your-sdk-key',
  streamingUri: 'wss://app-eval.featbit.co',
  eventsUri: 'https://app-eval.featbit.co'
});

OpenFeature.setProvider(provider);

// Get client
const client = OpenFeature.getClient();

// Evaluate flags
const isEnabled = await client.getBooleanValue('my-flag', false, {
  targetingKey: 'user-123'
});
```

## API Reference

### Boolean Flag
```javascript
const value = await client.getBooleanValue('flag-key', false, context);
```

### String Flag
```javascript
const value = await client.getStringValue('flag-key', 'default', context);
```

### Number Flag
```javascript
const value = await client.getNumberValue('flag-key', 0, context);
```

### Object Flag (JSON)
```javascript
const value = await client.getObjectValue('flag-key', {}, context);
```

### Detailed Evaluation
```javascript
const details = await client.getBooleanDetails('flag-key', false, context);
console.log(details.value, details.reason, details.variant);
```

## Event Handling

```javascript
// Provider ready
OpenFeature.addHandler(ProviderEvents.Ready, () => {
  console.log('Provider ready');
});

// Configuration changed
OpenFeature.addHandler(ProviderEvents.ConfigurationChanged, (details) => {
  console.log('Changed flags:', details.flagsChanged);
});

// Error handling
OpenFeature.addHandler(ProviderEvents.Error, (details) => {
  console.error('Error:', details.message);
});
```

## Evaluation Context

```javascript
const context = {
  targetingKey: 'user-123', // Required
  name: 'John Doe',
  email: 'john@example.com',
  tier: 'pro',
  // ... any custom attributes
};

const value = await client.getBooleanValue('flag-key', false, context);
```

## Cleanup

```javascript
// Flush events and close connections
await OpenFeature.close();
```

## Benefits of OpenFeature + FeatBit

1. **Standardized API**: Use the same code with any provider
2. **Real-time Updates**: FeatBit's WebSocket-based updates
3. **Advanced Targeting**: Leverage FeatBit's powerful targeting rules
4. **A/B Testing**: Built-in experimentation support
5. **Open Source**: No vendor lock-in
