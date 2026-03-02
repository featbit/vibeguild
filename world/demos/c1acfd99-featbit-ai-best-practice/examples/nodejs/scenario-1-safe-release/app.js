/**
 * Scenario 1: AI Model Safe Release with Feature Flags (Node.js)
 *
 * This example demonstrates how to safely release a new AI model using FeatBit
 * Feature Flags with gradual rollout and instant rollback capability.
 */

const express = require('express');
const { FbClientBuilder, UserBuilder } = require('@featbit/node-server-sdk');

const app = express();
app.use(express.json());

// =============================================================================
// FeatBit Configuration
// =============================================================================

const SDK_KEY = process.env.FEATBIT_SDK_KEY || '<your-sdk-key>';
const STREAMING_URI = process.env.FEATBIT_STREAMING_URI || 'wss://app-eval.featbit.co';
const EVENTS_URI = process.env.FEATBIT_EVENTS_URI || 'https://app-eval.featbit.co';

const FLAG_AI_V2_ENABLED = 'ai-customer-service-v2';

// Initialize FeatBit client
let fbClient;

async function initializeFeatBit() {
  fbClient = new FbClientBuilder()
    .sdkKey(SDK_KEY)
    .streamingUri(STREAMING_URI)
    .eventsUri(EVENTS_URI)
    .build();

  try {
    await fbClient.waitForInitialization();
    console.log('✅ FeatBit client initialized successfully');
  } catch (err) {
    console.error('❌ Failed to initialize FeatBit client:', err);
  }
}

// =============================================================================
// AI Service Layer
// =============================================================================

/**
 * Legacy AI model (GPT-3.5) - stable and well-tested
 */
async function getLegacyAIResponse(message, context = {}) {
  // In production, this would call the actual AI API
  return {
    response: `[GPT-3.5 Response] I understand you said: '${message}'. How can I help you further?`,
    model: 'gpt-3.5-turbo'
  };
}

/**
 * New AI model (GPT-4) - more capable but needs testing
 */
async function getV2AIResponse(message, context = {}) {
  // In production, this would call the actual AI API
  return {
    response: `[GPT-4 Response] Based on your message '${message}', I've analyzed the context and can provide more nuanced assistance...`,
    model: 'gpt-4-turbo'
  };
}

// =============================================================================
// Feature Flag Integration
// =============================================================================

/**
 * Evaluate which AI model to use for a given user
 */
async function getAIModelForUser(userId, userAttributes = {}) {
  if (!fbClient) {
    console.warn('FeatBit client not initialized, using legacy model');
    return { useV2Model: false, reason: 'client_not_initialized' };
  }

  const user = new UserBuilder(userId)
    .name(userAttributes.name || userId)
    .custom('tier', userAttributes.tier || 'free')
    .build();

  try {
    const detail = await fbClient.boolVariationDetail(FLAG_AI_V2_ENABLED, user, false);
    console.log(`Flag evaluation for user ${userId}: ${detail.value}, reason: ${detail.reason}`);
    return { useV2Model: detail.value, reason: detail.reason };
  } catch (err) {
    console.error('Flag evaluation error:', err);
    return { useV2Model: false, reason: 'evaluation_error' };
  }
}

// =============================================================================
// API Endpoints
// =============================================================================

/**
 * Health check endpoint
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    featbit_initialized: fbClient !== null
  });
});

/**
 * Main chat endpoint
 */
app.post('/api/chat', async (req, res) => {
  const { user_id, message, context } = req.body;

  if (!user_id || !message) {
    return res.status(400).json({ error: 'user_id and message are required' });
  }

  try {
    // Evaluate feature flag
    const { useV2Model, reason } = await getAIModelForUser(user_id, context);

    // Get response from appropriate AI model
    let result;
    if (useV2Model) {
      result = await getV2AIResponse(message, context);
    } else {
      result = await getLegacyAIResponse(message, context);
    }

    res.json({
      response: result.response,
      model_used: result.model,
      flag_evaluation_reason: reason
    });

  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Debug endpoint to check flag status for a user
 */
app.get('/api/flag-status/:userId', async (req, res) => {
  const { userId } = req.params;
  const { useV2Model, reason } = await getAIModelForUser(userId);

  res.json({
    user_id: userId,
    flag_key: FLAG_AI_V2_ENABLED,
    use_v2_model: useV2Model,
    reason
  });
});

// =============================================================================
// Graceful Shutdown
// =============================================================================

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  if (fbClient) {
    await fbClient.close();
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  if (fbClient) {
    await fbClient.close();
  }
  process.exit(0);
});

// =============================================================================
// Start Server
// =============================================================================

const PORT = process.env.PORT || 8000;

async function startServer() {
  await initializeFeatBit();

  app.listen(PORT, () => {
    console.log(`
    ╔══════════════════════════════════════════════════════════════╗
    ║   AI Customer Service API - Safe Release Demo (Node.js)     ║
    ╠══════════════════════════════════════════════════════════════╣
    ║   Endpoints:                                                 ║
    ║   - POST /api/chat         - Send chat message              ║
    ║   - GET  /api/health       - Health check                   ║
    ║   - GET  /api/flag-status/:userId - Check flag status       ║
    ║                                                              ║
    ║   Feature Flag: ai-customer-service-v2                       ║
    ╚══════════════════════════════════════════════════════════════╝
    `);
    console.log(`Server running on port ${PORT}`);
  });
}

startServer().catch(console.error);
