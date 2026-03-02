# React AI Feature Toggle Demo

## Overview

This example demonstrates real-time AI feature toggling in a React application using FeatBit.

## Features Demonstrated

- **Feature Status Display**: Show enabled/disabled status in UI
- **Conditional Rendering**: Components render based on flag values
- **Remote Configuration**: AI parameters from FeatBit JSON flags
- **Real-time Updates**: UI updates when flags change in FeatBit

## Setup

```bash
npm install

# Create .env file
REACT_APP_FEATBIT_SDK_KEY=your-sdk-key
REACT_APP_FEATBIT_STREAMING_URL=wss://app-eval.featbit.co
REACT_APP_FEATBIT_EVENTS_URL=https://app-eval.featbit.co
```

## Required Feature Flags

### 1. ai-assistant-enabled (Boolean)
Controls whether the AI assistant UI is shown.

### 2. ai-advanced-features (Boolean)
Controls whether advanced AI features are available.

### 3. ai-config (JSON)
```json
{
  "model": "gpt-4-turbo",
  "temperature": 0.7,
  "maxTokens": 2000,
  "systemPrompt": "You are a helpful assistant."
}
```

## Running

```bash
npm run dev
```

## Key Concepts

### Accessing Flags

```tsx
const flags = useFlags();
const isEnabled = flags['ai-assistant-enabled'];
```

### Conditional Rendering

```tsx
{aiAssistantEnabled ? (
  <AIAssistant />
) : (
  <FeatureDisabled />
)}
```

### Real-time Updates

When you change a flag in FeatBit, the React component automatically re-renders with the new value.
