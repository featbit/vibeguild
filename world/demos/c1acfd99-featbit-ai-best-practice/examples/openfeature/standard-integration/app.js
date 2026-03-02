/**
 * OpenFeature Standard Integration with FeatBit
 *
 * This example demonstrates using the OpenFeature standard API
 * with FeatBit as the backend provider.
 *
 * OpenFeature provides a vendor-agnostic API for feature flagging,
 * allowing you to switch providers without changing your code.
 */

const { OpenFeature, ProviderEvents } = require('@openfeature/server-sdk');
const { FbProvider } = require('@featbit/openfeature-provider-node-server');

// =============================================================================
// OpenFeature Configuration
// =============================================================================

const FEATBIT_CONFIG = {
  sdkKey: process.env.FEATBIT_SDK_KEY || '<your-sdk-key>',
  streamingUri: process.env.FEATBIT_STREAMING_URI || 'wss://app-eval.featbit.co',
  eventsUri: process.env.FEATBIT_EVENTS_URI || 'https://app-eval.featbit.co'
};

// =============================================================================
// Initialize OpenFeature with FeatBit Provider
// =============================================================================

async function initializeOpenFeature() {
  // Create FeatBit provider
  const provider = new FbProvider(FEATBIT_CONFIG);

  // Set the provider globally
  await OpenFeature.setProviderAndWait(provider);

  // Register event handlers
  OpenFeature.addHandler(ProviderEvents.Ready, () => {
    console.log('✅ OpenFeature provider is ready');
  });

  OpenFeature.addHandler(ProviderEvents.ConfigurationChanged, (details) => {
    console.log('🔄 Configuration changed:', details.flagsChanged);
  });

  OpenFeature.addHandler(ProviderEvents.Error, (details) => {
    console.error('❌ OpenFeature error:', details.message);
  });

  return provider;
}

// =============================================================================
// Feature Flag Evaluation Functions
// =============================================================================

/**
 * Evaluate a boolean feature flag
 */
async function getBooleanFlag(flagKey, userId, defaultValue = false) {
  const client = OpenFeature.getClient();
  return await client.getBooleanValue(flagKey, defaultValue, {
    targetingKey: userId
  });
}

/**
 * Evaluate a string feature flag
 */
async function getStringFlag(flagKey, userId, defaultValue = '') {
  const client = OpenFeature.getClient();
  return await client.getStringValue(flagKey, defaultValue, {
    targetingKey: userId
  });
}

/**
 * Evaluate a number feature flag
 */
async function getNumberFlag(flagKey, userId, defaultValue = 0) {
  const client = OpenFeature.getClient();
  return await client.getNumberValue(flagKey, defaultValue, {
    targetingKey: userId
  });
}

/**
 * Evaluate an object (JSON) feature flag
 */
async function getObjectFlag(flagKey, userId, defaultValue = {}) {
  const client = OpenFeature.getClient();
  return await client.getObjectValue(flagKey, defaultValue, {
    targetingKey: userId
  });
}

/**
 * Get detailed evaluation result
 */
async function getFlagDetails(flagKey, userId, defaultValue) {
  const client = OpenFeature.getClient();
  return await client.getBooleanDetails(flagKey, defaultValue, {
    targetingKey: userId
  });
}

// =============================================================================
// AI Service Using OpenFeature
// =============================================================================

class AIService {
  constructor() {
    this.client = null;
  }

  async initialize() {
    await initializeOpenFeature();
    this.client = OpenFeature.getClient();
  }

  /**
   * Check if AI feature is enabled for user
   */
  async isFeatureEnabled(userId, featureKey) {
    return await this.client.getBooleanValue(
      `ai-${featureKey}-enabled`,
      false,
      { targetingKey: userId }
    );
  }

  /**
   * Get AI configuration for user
   */
  async getAIConfig(userId) {
    const defaultConfig = {
      model: 'gpt-3.5-turbo',
      temperature: 0.7,
      maxTokens: 1000
    };

    return await this.client.getObjectValue(
      'ai-config',
      defaultConfig,
      { targetingKey: userId }
    );
  }

  /**
   * Get AI model to use (for A/B testing)
   */
  async getAIModel(userId) {
    return await this.client.getStringValue(
      'ai-model-strategy',
      'gpt-3.5-turbo',
      { targetingKey: userId }
    );
  }

  /**
   * Get temperature setting
   */
  async getTemperature(userId) {
    return await this.client.getNumberValue(
      'ai-temperature',
      0.7,
      { targetingKey: userId }
    );
  }

  /**
   * Process AI request with feature flags
   */
  async processRequest(userId, message) {
    // Check if AI is enabled for this user
    const isEnabled = await this.isFeatureEnabled(userId, 'assistant');
    if (!isEnabled) {
      return { error: 'AI assistant not enabled for this user' };
    }

    // Get configuration
    const config = await this.getAIConfig(userId);
    const model = await this.getAIModel(userId);

    // Process with configuration
    return {
      message: `Processed with ${model}`,
      config,
      model
    };
  }
}

// =============================================================================
// Example Usage
// =============================================================================

async function main() {
  console.log('🚀 Initializing OpenFeature with FeatBit...');

  const aiService = new AIService();
  await aiService.initialize();

  console.log('\n📋 Testing Feature Flag Evaluations...\n');

  // Test boolean flag
  const assistantEnabled = await aiService.isFeatureEnabled('user-001', 'assistant');
  console.log(`AI Assistant enabled for user-001: ${assistantEnabled}`);

  // Test string flag (A/B test)
  const model = await aiService.getAIModel('user-001');
  console.log(`AI Model for user-001: ${model}`);

  // Test number flag
  const temperature = await aiService.getTemperature('user-001');
  console.log(`Temperature for user-001: ${temperature}`);

  // Test object flag
  const config = await aiService.getAIConfig('user-001');
  console.log(`Config for user-001:`, config);

  // Test full request
  console.log('\n🔄 Processing AI request...\n');
  const result = await aiService.processRequest('user-001', 'Hello!');
  console.log('Result:', result);

  // Test detailed evaluation
  console.log('\n📊 Detailed Evaluation...\n');
  const details = await getFlagDetails('ai-assistant-enabled', 'user-001', false);
  console.log('Evaluation details:', {
    value: details.value,
    reason: details.reason,
    variant: details.variant,
    flagMetadata: details.flagMetadata
  });

  // Cleanup
  console.log('\n🧹 Shutting down...');
  await OpenFeature.close();
  console.log('✅ Done!');
}

// Run example
main().catch(console.error);

// =============================================================================
// Export for use as module
// =============================================================================

module.exports = {
  initializeOpenFeature,
  getBooleanFlag,
  getStringFlag,
  getNumberFlag,
  getObjectFlag,
  getFlagDetails,
  AIService
};
