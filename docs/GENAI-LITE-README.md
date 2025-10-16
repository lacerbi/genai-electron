# genai-lite

A lightweight, portable Node.js/TypeScript library providing a unified interface for interacting with multiple Generative AI providers—both cloud-based (OpenAI, Anthropic, Google Gemini, Mistral) and local (llama.cpp).

## Features

- 🔌 **Unified API** - Single interface for multiple AI providers
- 🏠 **Local & Cloud Models** - Run models locally with llama.cpp or use cloud APIs
- 🔐 **Flexible API Key Management** - Bring your own key storage solution
- 📦 **Zero Electron Dependencies** - Works in any Node.js environment
- 🎯 **TypeScript First** - Full type safety and IntelliSense support
- ⚡ **Lightweight** - Minimal dependencies, focused functionality
- 🛡️ **Provider Normalization** - Consistent responses across different AI APIs
- 🎨 **Configurable Model Presets** - Built-in presets with full customization options
- 🎭 **Template Engine** - Sophisticated templating with conditionals and variable substitution

## Installation

```bash
npm install genai-lite
```

## Quick Start

### Cloud Providers (OpenAI, Anthropic, Gemini, Mistral)

```typescript
import { LLMService, fromEnvironment } from 'genai-lite';

// Create service with environment variable API key provider
const llmService = new LLMService(fromEnvironment);

const response = await llmService.sendMessage({
  providerId: 'openai',
  modelId: 'gpt-4.1-mini',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello, how are you?' }
  ]
});

if (response.object === 'chat.completion') {
  console.log(response.choices[0].message.content);
} else {
  console.error('Error:', response.error.message);
}
```

### Local Models (llama.cpp)

```typescript
import { LLMService } from 'genai-lite';

// Start llama.cpp server first: llama-server -m /path/to/model.gguf --port 8080
const llmService = new LLMService(async () => 'not-needed');

const response = await llmService.sendMessage({
  providerId: 'llamacpp',
  modelId: 'llama-3-8b-instruct',  // Must match your loaded model
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Explain quantum computing briefly.' }
  ]
});

if (response.object === 'chat.completion') {
  console.log(response.choices[0].message.content);
}
```

See the [llama.cpp Integration](#llamacpp-integration) section for setup details.

## Example Application

For a complete, production-ready example showcasing all genai-lite capabilities, see the **[chat-demo](examples/chat-demo)** interactive web application. The demo includes:
- Multi-provider chat interface with all supported providers
- Template rendering and model presets
- llama.cpp utilities (tokenization, embeddings, health checks)
- Settings persistence, export/import features

The chat-demo serves as both a comprehensive showcase and a quick-test environment for library changes.

## API Key Management

genai-lite uses a flexible API key provider pattern. You can use the built-in environment variable provider or create your own:

### Environment Variables (Built-in)

```typescript
import { fromEnvironment } from 'genai-lite';

// Expects environment variables like:
// OPENAI_API_KEY=sk-...
// ANTHROPIC_API_KEY=sk-ant-...
// GEMINI_API_KEY=...

const llmService = new LLMService(fromEnvironment);
```

### Custom API Key Provider

```typescript
import { ApiKeyProvider, LLMService } from 'genai-lite';

// Create your own provider
const myKeyProvider: ApiKeyProvider = async (providerId: string) => {
  // Fetch from your secure storage, vault, etc.
  const key = await mySecureStorage.getKey(providerId);
  return key || null;
};

const llmService = new LLMService(myKeyProvider);
```

## Supported Providers & Models

**Note:** Model IDs include version dates for precise model selection. Always use the exact model ID as shown below.

### Anthropic (Claude)
- **Claude 4** (Latest generation):
  - `claude-sonnet-4-20250514` - Balanced performance model
  - `claude-opus-4-20250514` - Most powerful for complex tasks
- **Claude 3.7**: `claude-3-7-sonnet-20250219` - Advanced reasoning
- **Claude 3.5**:
  - `claude-3-5-sonnet-20241022` - Best balance of speed and intelligence
  - `claude-3-5-haiku-20241022` - Fast and cost-effective

### Google Gemini
- **Gemini 2.5** (Latest generation):
  - `gemini-2.5-pro` - Most advanced multimodal capabilities
  - `gemini-2.5-flash` - Fast with large context window
  - `gemini-2.5-flash-lite-preview-06-17` - Most cost-effective
- **Gemini 2.0**:
  - `gemini-2.0-flash` - High performance multimodal
  - `gemini-2.0-flash-lite` - Lightweight version

### OpenAI
- **o4 series**: `o4-mini` - Advanced reasoning model
- **GPT-4.1 series**:
  - `gpt-4.1` - Latest GPT-4 with enhanced capabilities
  - `gpt-4.1-mini` - Cost-effective for most tasks
  - `gpt-4.1-nano` - Ultra-efficient version

### Mistral
> **Note:** The official Mistral adapter is under development. Requests made to Mistral models will currently be handled by a mock adapter for API compatibility testing.

- `codestral-2501` - Specialized for code generation
- `devstral-small-2505` - Compact development-focused model

### llama.cpp (Local Models)

Run models locally via [llama.cpp](https://github.com/ggml-org/llama.cpp) server. Model IDs can be any name—they're not validated since you load your own GGUF models.

**Example models:**
- `llama-3-8b-instruct` - Llama 3 8B Instruct
- `llama-3-70b-instruct` - Llama 3 70B Instruct
- `mistral-7b-instruct` - Mistral 7B Instruct
- `my-custom-model` - Any custom model you've loaded

**Setup:**

1. Start llama.cpp server with your model:
```bash
llama-server -m /path/to/model.gguf --port 8080
```

2. Use with genai-lite (no API key needed):
```typescript
import { LLMService } from 'genai-lite';

// API key can be any string for llama.cpp
const service = new LLMService(async () => 'not-needed');

const response = await service.sendMessage({
  providerId: 'llamacpp',
  modelId: 'llama-3-8b-instruct', // Must match your loaded model name
  messages: [{ role: 'user', content: 'Hello!' }]
});
```

3. Configure server URL via environment variable:
```bash
export LLAMACPP_API_BASE_URL=http://localhost:8080
```

**Advanced features** - Access non-LLM endpoints:

```typescript
import { LlamaCppServerClient } from 'genai-lite';

const client = new LlamaCppServerClient('http://localhost:8080');

// Check server health
const health = await client.getHealth();

// Tokenize text
const { tokens } = await client.tokenize('Hello world');

// Generate embeddings
const { embedding } = await client.createEmbedding('Some text');

// Code completion
const result = await client.infill('def hello():\n', '\nprint("done")');
```

See the [llama.cpp Integration](#llamacpp-integration) section for details.

### Models with Reasoning Support

Some models include advanced reasoning/thinking capabilities that enhance their problem-solving abilities:

- **Anthropic**: Claude Sonnet 4, Claude Opus 4, Claude 3.7 Sonnet
- **Google Gemini**: Gemini 2.5 Pro (always on), Gemini 2.5 Flash, Gemini 2.5 Flash-Lite Preview
- **OpenAI**: o4-mini (always on)

See the [Reasoning Mode](#reasoning-mode) section for usage details.

## Advanced Usage

### Custom Settings

```typescript
const response = await llmService.sendMessage({
  providerId: 'anthropic',
  modelId: 'claude-3-5-haiku-20241022',
  messages: [{ role: 'user', content: 'Write a haiku' }],
  settings: {
    temperature: 0.7,
    maxTokens: 100,
    topP: 0.9,
    stopSequences: ['\n\n']
  }
});
```

### Reasoning Mode

Enable advanced reasoning capabilities for supported models to get step-by-step thinking and improved problem-solving:

```typescript
// Enable reasoning with automatic token budget
const response = await llmService.sendMessage({
  providerId: 'gemini',
  modelId: 'gemini-2.5-flash',
  messages: [{ role: 'user', content: 'Solve this step by step: If a train travels 120km in 2 hours, what is its speed in m/s?' }],
  settings: {
    reasoning: {
      enabled: true  // Let the model decide how much thinking to do
    }
  }
});

// Use effort levels for quick control
const response = await llmService.sendMessage({
  providerId: 'anthropic',
  modelId: 'claude-3-7-sonnet-20250219',
  messages: [{ role: 'user', content: 'Analyze this complex problem...' }],
  settings: {
    reasoning: {
      enabled: true,
      effort: 'high'  // 'low', 'medium', or 'high'
    }
  }
});

// Set specific token budget for reasoning
const response = await llmService.sendMessage({
  providerId: 'gemini',
  modelId: 'gemini-2.5-flash-lite-preview-06-17',
  messages: [{ role: 'user', content: 'What is the square root of 144?' }],
  settings: {
    reasoning: {
      enabled: true,
      maxTokens: 5000  // Specific token budget for reasoning
    }
  }
});

// Access reasoning output (if available)
if (response.object === 'chat.completion' && response.choices[0].reasoning) {
  console.log('Model reasoning:', response.choices[0].reasoning);
  console.log('Final answer:', response.choices[0].message.content);
}
```

**Reasoning Options:**
- `enabled`: Turn reasoning on/off (some models like o4-mini and Gemini 2.5 Pro have it always on)
- `effort`: Quick presets - 'low' (20% budget), 'medium' (50%), 'high' (80%)
- `maxTokens`: Specific token budget for reasoning
- `exclude`: Set to `true` to enable reasoning but exclude it from the response

**Important Notes:**
- Reasoning tokens are billed separately and may cost more
- Some models (o4-mini, Gemini 2.5 Pro) cannot disable reasoning
- Not all models support reasoning - check the [supported models](#models-with-reasoning-support) list
- The `reasoning` field in the response contains the model's thought process (when available)

### Thinking Extraction and Enforcement

For models without native reasoning, you can prompt them to output reasoning in XML tags like `<thinking>`. The library then extracts these tags and moves the content to the standardized `reasoning` field, providing a consistent interface across all models.

**Key point:** The library doesn't make models think automatically—you must explicitly instruct non-reasoning models to use thinking tags in your prompt. The library then enforces that these tags are present (for non-reasoning models) or accepts native reasoning (for reasoning models).

```typescript
// Prompt the model to think step-by-step in a <thinking> tag
const response = await llmService.sendMessage({
  providerId: 'openai',
  modelId: 'gpt-4.1',
  messages: [{
    role: 'system',
    content: 'When solving problems, first write your reasoning inside <thinking> tags, then provide the answer.'
  }, {
    role: 'user',
    content: 'Please think through this problem step by step before answering: What is 15% of 240?'
  }],
  settings: {
    thinkingTagFallback: { enabled: true } // Must explicitly enable
  }
});

// If the model responds with:
// "<thinking>15% means 15/100 = 0.15. So 15% of 240 = 0.15 × 240 = 36.</thinking>The answer is 36."
// 
// The response will have:
// - response.choices[0].message.content = "The answer is 36."
// - response.choices[0].reasoning = "15% means 15/100 = 0.15. So 15% of 240 = 0.15 × 240 = 36."

// If the model doesn't include the <thinking> tag, you'll get an error (with default 'auto' mode)
```

**Configuration Options:**

```typescript
const response = await llmService.sendMessage({
  providerId: 'anthropic',
  modelId: 'claude-3-5-haiku-20241022',
  messages: [{ role: 'user', content: 'Solve this step by step...' }],
  settings: {
    thinkingTagFallback: {
      enabled: true,     // Must explicitly enable (default: false)
      tagName: 'scratchpad', // Custom tag name (default: 'thinking')
      enforce: true  // Smart enforcement (see below)
    }
  }
});
```

**The `enforce` Property:**

The `enforce` boolean controls whether thinking tags are required when native reasoning is not active:

- `enforce: true` - Error if tags missing AND native reasoning not active (smart enforcement)
- `enforce: false` (default) - Extract tags if present, never error

The enforcement is **always smart** - it automatically checks if native reasoning is active and only enforces when the model needs tags as a fallback.

**How Smart Enforcement Works:**

```typescript
// With non-native reasoning models (e.g., GPT-4)
const response = await llmService.sendMessage({
  providerId: 'openai',
  modelId: 'gpt-4.1',
  messages: [{
    role: 'system',
    content: 'Always think in <thinking> tags before answering.'
  }, {
    role: 'user',
    content: 'What is 15% of 240?'
  }],
  settings: {
    thinkingTagFallback: { enabled: true, enforce: true }
  }
});
// Result: ERROR if <thinking> tag is missing (native reasoning not active)
// The response is still accessible via errorResponse.partialResponse

// With native reasoning models (e.g., Claude with reasoning enabled)
const response = await llmService.sendMessage({
  providerId: 'anthropic',
  modelId: 'claude-3-7-sonnet-20250219',
  messages: [/* same prompt */],
  settings: {
    reasoning: { enabled: true },
    thinkingTagFallback: { enabled: true, enforce: true }
  }
});
// Result: SUCCESS even if <thinking> tag is missing (native reasoning is active)
```

This intelligent enforcement ensures that:
- Non-native models are held to strict requirements when instructed to use thinking tags
- Native reasoning models aren't penalized for using their built-in reasoning instead of tags
- The same prompt can work across different model types

### Provider Information

```typescript
// Get list of supported providers
const providers = await llmService.getProviders();

// Get models for a specific provider
const models = await llmService.getModels('anthropic');

// Get configured model presets
const presets = llmService.getPresets();
```

### Model Presets

genai-lite includes a comprehensive set of model presets for common use cases. You can use these defaults, extend them with your own, or replace them entirely.

#### Using Default Presets

The library ships with over 20 pre-configured presets (defined in `src/config/presets.json`), including specialized "thinking" presets for models with reasoning capabilities:

```typescript
const llmService = new LLMService(fromEnvironment);

// Get all default presets
const presets = llmService.getPresets();
// Returns presets like:
// - anthropic-claude-sonnet-4-20250514-default
// - anthropic-claude-sonnet-4-20250514-thinking (reasoning enabled)
// - openai-gpt-4.1-default
// - google-gemini-2.5-flash-thinking (reasoning enabled)
// ... and many more
```

The thinking presets automatically enable reasoning mode for supported models, making it easy to leverage advanced problem-solving capabilities without manual configuration.

#### Extending Default Presets

```typescript
import { LLMService, fromEnvironment, ModelPreset } from 'genai-lite';

const customPresets: ModelPreset[] = [
  {
    id: 'my-creative-preset',
    displayName: 'Creative Writing Assistant',
    providerId: 'openai',
    modelId: 'gpt-4.1',
    settings: {
      temperature: 0.9,
      maxTokens: 2000,
      topP: 0.95
    }
  }
];

const llmService = new LLMService(fromEnvironment, {
  presets: customPresets,
  presetMode: 'extend' // Default behavior - adds to existing presets
});
```

#### Replacing Default Presets

For applications that need full control over available presets:

```typescript
const applicationPresets: ModelPreset[] = [
  {
    id: 'app-gpt4-default',
    displayName: 'GPT-4 Standard',
    providerId: 'openai',
    modelId: 'gpt-4.1',
    settings: { temperature: 0.7 }
  },
  {
    id: 'app-claude-creative',
    displayName: 'Claude Creative',
    providerId: 'anthropic',
    modelId: 'claude-3-5-sonnet-20241022',
    settings: { temperature: 0.8, maxTokens: 4000 }
  }
];

const llmService = new LLMService(fromEnvironment, {
  presets: applicationPresets,
  presetMode: 'replace' // Use ONLY these presets, ignore defaults
});
```

### Using Presets with Messages

You can use presets directly in `sendMessage` calls:

```typescript
// Send a message using a preset
const response = await llmService.sendMessage({
  presetId: 'anthropic-claude-3-7-sonnet-20250219-thinking',
  messages: [{ role: 'user', content: 'Solve this complex problem...' }]
});

// Override preset settings
const response = await llmService.sendMessage({
  presetId: 'openai-gpt-4.1-default',
  messages: [{ role: 'user', content: 'Write a story' }],
  settings: {
    temperature: 0.9, // Override preset's temperature
    maxTokens: 3000
  }
});
```

### Creating Messages from Templates

The library provides a powerful `createMessages` method that combines template rendering, model context injection, and role tag parsing into a single, intuitive API:

```typescript
// Basic example: Create model-aware messages
const { messages, modelContext } = await llmService.createMessages({
  template: `
    <SYSTEM>You are a helpful assistant.</SYSTEM>
    <USER>{{ question }}</USER>
  `,
  variables: {
    question: 'What is the optimal algorithm for finding the shortest path in a weighted graph?'
  },
  presetId: 'anthropic-claude-3-7-sonnet-20250219-thinking'
});

// The messages are ready to send
const response = await llmService.sendMessage({
  presetId: 'anthropic-claude-3-7-sonnet-20250219-thinking',
  messages: messages
});

// Advanced example: Conditional context and multi-turn conversation
const { messages } = await llmService.createMessages({
  template: `
    <SYSTEM>You are an expert code reviewer.</SYSTEM>
    {{ hasContext ? '<USER>Context: {{context}}</USER>' : '' }}
    <USER>Review this code:
```{{language}}
{{code}}
```</USER>
    {{ hasExamples ? examples : '' }}
    <USER>Focus on {{ focusAreas.join(', ') }}.</USER>
  `,
  variables: { 
    hasContext: true,
    context: 'This is part of a high-performance web server',
    language: 'typescript',
    code: 'async function handleRequest(req: Request) { ... }',
    hasExamples: true,
    examples: '<ASSISTANT>I\'ll review your code focusing on the areas you mentioned.</ASSISTANT>',
    focusAreas: ['error handling', 'performance', 'type safety']
  },
  providerId: 'openai',
  modelId: 'gpt-4.1'
});
```

The method provides:
- **Unified API**: Single method for all prompt creation needs
- **Model Context Injection**: Automatically injects model-specific variables
- **Template Rendering**: Full support for conditionals and variable substitution
- **Role Tag Parsing**: Converts `<SYSTEM>`, `<USER>`, and `<ASSISTANT>` tags to messages

**Available model context variables:**

- `native_reasoning_active`: Whether native reasoning is **currently active** for this request
  - `true`: The model is using built-in reasoning (e.g., Claude 4, o4-mini, Gemini 2.5 Pro with reasoning enabled)
  - `false`: No native reasoning is active (either because the model doesn't support it, or it's been disabled)
- `native_reasoning_capable`: Whether the model **has the capability** to use native reasoning
  - `true`: Model supports native reasoning (may or may not be enabled)
  - `false`: Model does not support native reasoning
- `model_id`: The resolved model ID
- `provider_id`: The resolved provider ID
- `reasoning_effort`: The reasoning effort level if specified
- `reasoning_max_tokens`: The reasoning token budget if specified

**Best Practice for Templates:**
When adding thinking tag instructions to your templates, **always use `requires_tags_for_thinking`** (the NOT operator). This ensures:
- Models with active native reasoning get clean, direct prompts
- Models without native reasoning get explicit instructions to use `<thinking>` tags

Example: `{{ requires_tags_for_thinking ? ' Write your reasoning in <thinking> tags first.' : '' }}`

#### Advanced Features

**Dynamic Role Injection:**
Variables can dynamically inject entire role blocks, enabling flexible conversation flows:

```typescript
const { messages } = await llmService.createMessages({
  template: `
    {{ includeSystemPrompt ? '<SYSTEM>{{systemPrompt}}</SYSTEM>' : '' }}
    {{ examples ? examples : '' }}
    <USER>{{userQuery}}</USER>
  `,
  variables: {
    includeSystemPrompt: true,
    systemPrompt: 'You are an expert code reviewer.',
    examples: `
      <USER>Review this code: const x = 1</USER>
      <ASSISTANT>The variable name 'x' is not descriptive...</ASSISTANT>
    `,
    userQuery: 'Review this: const data = fetchData()'
  },
  presetId: 'anthropic-claude-3-5-sonnet-20241022'
});
```

**Combining with Thinking Extraction:**
When using models without native reasoning support, combine createMessages with thinking extraction:

```typescript
// Prompt any model to think before answering
const { messages } = await llmService.createMessages({
  template: `
    <SYSTEM>
      When solving problems, first write your step-by-step reasoning inside <thinking> tags,
      then provide your final answer.
    </SYSTEM>
    <USER>{{ question }}</USER>
  `,
  variables: { question: 'If a train travels 120km in 2 hours, what is its speed in m/s?' },
  providerId: 'openai',
  modelId: 'gpt-4.1'
});

// Send with automatic thinking extraction
const response = await llmService.sendMessage({
  providerId: 'openai',
  modelId: 'gpt-4.1',
  messages,
  settings: {
    thinkingTagFallback: { enabled: true } // Default, but shown for clarity
  }
});

// Access both reasoning and answer
if (response.object === 'chat.completion') {
  console.log('Reasoning:', response.choices[0].reasoning);
  console.log('Answer:', response.choices[0].message.content);
}
```

### Self-Contained Templates with Metadata

Templates can now include their own settings using a `<META>` block, making them truly self-contained and reusable:

```typescript
// Define a template with embedded settings
const creativeWritingTemplate = `
<META>
{
  "settings": {
    "temperature": 0.9,
    "maxTokens": 3000,
    "thinkingTagFallback": { "enabled": true, "tagName": "reasoning" }
  }
}
</META>
<SYSTEM>
You are a creative writer. Use <reasoning> tags to outline your story structure 
before writing the actual story.
</SYSTEM>
<USER>Write a short story about {{ topic }}</USER>
`;

// Use the template - settings are automatically extracted
const { messages, settings } = await llmService.createMessages({
  template: creativeWritingTemplate,
  variables: { topic: 'a robot discovering music' },
  providerId: 'openai',
  modelId: 'gpt-4.1'
});

// Send the message with the template's settings
const response = await llmService.sendMessage({
  providerId: 'openai',
  modelId: 'gpt-4.1',
  messages,
  settings  // Uses temperature: 0.9, maxTokens: 3000, etc.
});
```

**Benefits of Self-Contained Templates:**
- **Portability**: Templates carry their optimal settings with them
- **Consistency**: Same template always uses the same settings
- **Less Error-Prone**: No need to remember settings for each template
- **Shareable**: Easy to share templates with all necessary configuration

**Settings Hierarchy:**
When multiple settings sources exist, they are merged in this order (later overrides earlier):
1. Model defaults (lowest priority)
2. Preset settings
3. Template `<META>` settings
4. Runtime settings in `sendMessage()` (highest priority)

```typescript
// Example of settings hierarchy
const { messages, settings: templateSettings } = await llmService.createMessages({
  template: `<META>{"settings": {"temperature": 0.8}}</META><USER>Hello</USER>`,
  presetId: 'some-preset' // Preset might have temperature: 0.7
});

// Final temperature will be 0.9 (runtime overrides all)
const response = await llmService.sendMessage({
  presetId: 'some-preset',
  messages,
  settings: {
    ...templateSettings,
    temperature: 0.9  // Runtime override
  }
});
```

**Validation:**
Invalid settings in the `<META>` block are logged as warnings and ignored:

```typescript
const template = `
<META>
{
  "settings": {
    "temperature": 3.0,      // Invalid: will be ignored with warning
    "maxTokens": 2000,       // Valid: will be used
    "unknownSetting": "foo"  // Unknown: will be ignored with warning
  }
}
</META>
<USER>Test</USER>
`;
```

### Error Handling

```typescript
const response = await llmService.sendMessage({
  providerId: 'openai',
  modelId: 'gpt-4.1-mini',
  messages: [{ role: 'user', content: 'Hello' }]
});

if (response.object === 'error') {
  switch (response.error.type) {
    case 'authentication_error':
      console.error('Invalid API key');
      break;
    case 'rate_limit_error':
      console.error('Rate limit exceeded');
      break;
    case 'validation_error':
      console.error('Invalid request:', response.error.message);
      // For validation errors, the response may still be available
      if (response.partialResponse) {
        console.log('Partial response:', response.partialResponse.choices[0].message.content);
      }
      break;
    default:
      console.error('Error:', response.error.message);
  }
}
```

## llama.cpp Integration

`genai-lite` provides comprehensive support for running local LLMs via [llama.cpp](https://github.com/ggml-org/llama.cpp) server, enabling completely offline AI capabilities with the same unified interface.

### Why llama.cpp?

- **Privacy**: All model inference runs locally on your hardware
- **Cost**: No API costs after initial model download
- **Control**: Use any GGUF model from Hugging Face
- **Performance**: Optimized C++ implementation with hardware acceleration

### Setup

#### 1. Install llama.cpp

```bash
# Clone and build llama.cpp
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp
make

# Or download pre-built binaries from releases
```

#### 2. Download a Model

Get GGUF models from Hugging Face, for example:
- [Meta-Llama-3.1-8B-Instruct-GGUF](https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF)
- [Mistral-7B-Instruct-v0.3-GGUF](https://huggingface.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF)

#### 3. Start the Server

```bash
# Basic usage
llama-server -m /path/to/model.gguf --port 8080

# With more options
llama-server -m /path/to/model.gguf \
  --port 8080 \
  -c 4096 \           # Context size
  -np 4 \             # Parallel requests
  --threads 8         # CPU threads
```

### Basic Usage

```typescript
import { LLMService } from 'genai-lite';

// llama.cpp doesn't need API keys
const service = new LLMService(async () => 'not-needed');

const response = await service.sendMessage({
  providerId: 'llamacpp',
  modelId: 'llama-3-8b-instruct',  // Arbitrary name matching your model
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Explain quantum computing in simple terms.' }
  ],
  settings: {
    temperature: 0.7,
    maxTokens: 500
  }
});

if (response.object === 'chat.completion') {
  console.log(response.choices[0].message.content);
}
```

### Configuration

#### Environment Variable

Set the server URL via environment variable (default: `http://localhost:8080`):

```bash
export LLAMACPP_API_BASE_URL=http://localhost:8080
```

#### Multiple Servers

Register multiple llama.cpp instances for different models:

```typescript
import { LLMService, LlamaCppClientAdapter } from 'genai-lite';

const service = new LLMService(async () => 'not-needed');

// Register adapters for different servers/models
service.registerAdapter(
  'llamacpp-small',
  new LlamaCppClientAdapter({ baseURL: 'http://localhost:8080' })
);

service.registerAdapter(
  'llamacpp-large',
  new LlamaCppClientAdapter({ baseURL: 'http://localhost:8081' })
);

// Use them
const response = await service.sendMessage({
  providerId: 'llamacpp-small',
  modelId: 'llama-3-8b',
  messages: [{ role: 'user', content: 'Hello!' }]
});
```

#### Health Checking

Enable automatic health checks before requests:

```typescript
import { LlamaCppClientAdapter } from 'genai-lite';

const adapter = new LlamaCppClientAdapter({
  baseURL: 'http://localhost:8080',
  checkHealth: true  // Check server status before each request
});

service.registerAdapter('llamacpp', adapter);
```

### Advanced Features

#### Server Management

The `LlamaCppServerClient` class provides access to all llama.cpp server endpoints:

```typescript
import { LlamaCppServerClient } from 'genai-lite';

const client = new LlamaCppServerClient('http://localhost:8080');

// Health monitoring
const health = await client.getHealth();
console.log(health.status); // 'ok', 'loading', or 'error'

// Server properties
const props = await client.getProps();
console.log(props.total_slots); // Number of available slots

// Performance metrics (if enabled)
const metrics = await client.getMetrics();
```

#### Tokenization

```typescript
const client = new LlamaCppServerClient('http://localhost:8080');

// Tokenize text
const { tokens } = await client.tokenize('Hello, world!');
console.log(tokens); // [123, 456, 789]

// Count tokens before sending to LLM
const prompt = 'Long text...';
const { tokens: promptTokens } = await client.tokenize(prompt);
if (promptTokens.length > 4000) {
  console.log('Prompt too long, truncating...');
}

// Detokenize back to text
const { content } = await client.detokenize([123, 456, 789]);
console.log(content); // 'Hello, world!'
```

#### Text Embeddings

```typescript
const client = new LlamaCppServerClient('http://localhost:8080');

// Generate embeddings for semantic search
const { embedding } = await client.createEmbedding('Search query text');
console.log(embedding.length); // e.g., 768 dimensions

// With images (for multimodal models)
const { embedding: multimodalEmbed } = await client.createEmbedding(
  'Describe this image',
  'base64_image_data_here'
);
```

#### Code Infilling

Perfect for code completion in IDEs:

```typescript
const client = new LlamaCppServerClient('http://localhost:8080');

const result = await client.infill(
  'def calculate_fibonacci(n):\n    ',  // Prefix (before cursor)
  '\n    return result'                   // Suffix (after cursor)
);

console.log(result.content);
// Output: "if n <= 1:\n        return n\n    result = calculate_fibonacci(n-1) + calculate_fibonacci(n-2)"
```

### Error Handling

```typescript
const response = await service.sendMessage({
  providerId: 'llamacpp',
  modelId: 'my-model',
  messages: [{ role: 'user', content: 'Hello' }]
});

if (response.object === 'error') {
  switch (response.error.code) {
    case 'NETWORK_ERROR':
      console.error('Server not running or unreachable');
      break;
    case 'PROVIDER_ERROR':
      console.error('Server error:', response.error.message);
      break;
    default:
      console.error('Unknown error:', response.error);
  }
}
```

### Best Practices

1. **Model Naming**: Use descriptive model IDs (e.g., `llama-3-8b-instruct`) since llama.cpp accepts any name
2. **Context Size**: Set appropriate context (`-c` flag) when starting the server
3. **Parallel Requests**: Configure slots (`-np`) based on your hardware
4. **Health Monitoring**: Enable `checkHealth` for production to detect server issues early
5. **Resource Management**: Monitor memory usage; large models need significant RAM

### Troubleshooting

**Server not responding:**
```bash
# Check if server is running
curl http://localhost:8080/health

# Should return: {"status":"ok"}
```

**Model loading errors:**
```bash
# Increase memory or reduce context size
llama-server -m model.gguf --port 8080 -c 2048
```

**Slow responses:**
```bash
# Use quantized models (smaller but faster)
# e.g., Q4_K_M, Q5_K_M instead of F16

# Increase threads
llama-server -m model.gguf --threads 16
```

## Using with Electron

`genai-lite` is designed to work seamlessly within an Electron application's main process, especially when paired with a secure storage solution like `genai-key-storage-lite`.

This is the recommended pattern for both new Electron apps and for migrating from older, integrated versions.

### Example with `genai-key-storage-lite`

Here’s how to create a custom `ApiKeyProvider` that uses `genai-key-storage-lite` to securely retrieve API keys.

```typescript
// In your Electron app's main process (e.g., main.ts)
import { app } from 'electron';
import { ApiKeyServiceMain } from 'genai-key-storage-lite';
import { LLMService, type ApiKeyProvider } from 'genai-lite';

// 1. Initialize Electron's secure key storage service
const apiKeyService = new ApiKeyServiceMain(app.getPath("userData"));

// 2. Create a custom ApiKeyProvider that uses the secure storage
const electronKeyProvider: ApiKeyProvider = async (providerId) => {
  try {
    // Use withDecryptedKey to securely access the key only when needed.
    // The key is passed to the callback and its result is returned.
    return await apiKeyService.withDecryptedKey(providerId, async (key) => key);
  } catch {
    // If key is not found or decryption fails, return null.
    // LLMService will handle this as an authentication error.
    return null;
  }
};

// 3. Initialize the genai-lite service with our custom provider
const llmService = new LLMService(electronKeyProvider);

// Now you can use llmService anywhere in your main process.
```

## TypeScript Support

genai-lite is written in TypeScript and provides comprehensive type definitions:

```typescript
import type {
  LLMChatRequest,
  LLMChatRequestWithPreset,
  LLMResponse,
  LLMFailureResponse,
  LLMSettings,
  LLMReasoningSettings,
  LLMThinkingTagFallbackSettings,
  ApiKeyProvider,
  ModelPreset,
  LLMServiceOptions,
  PresetMode,
  ModelContext,
  CreateMessagesResult,
  TemplateMetadata
} from 'genai-lite';

// llama.cpp integration types and classes
import {
  LlamaCppClientAdapter,
  LlamaCppServerClient,
  createFallbackModelInfo
} from 'genai-lite';

import type {
  LlamaCppClientConfig,
  LlamaCppHealthResponse,
  LlamaCppTokenizeResponse,
  LlamaCppDetokenizeResponse,
  LlamaCppEmbeddingResponse,
  LlamaCppInfillResponse,
  LlamaCppPropsResponse,
  LlamaCppMetricsResponse,
  LlamaCppSlot,
  LlamaCppSlotsResponse
} from 'genai-lite';
```

## Utilities

genai-lite includes useful utilities for working with LLMs, available through the `genai-lite/prompting` subpath:

### Token Counting

Count the number of tokens in a string using OpenAI's tiktoken library:

```typescript
import { countTokens } from 'genai-lite/prompting';

const text = 'Hello, this is a sample text for token counting.';
const tokenCount = countTokens(text); // Uses gpt-4 tokenizer by default
console.log(`Token count: ${tokenCount}`);

// Specify a different model's tokenizer
const gpt35Tokens = countTokens(text, 'gpt-3.5-turbo');
```

**Note:** The `countTokens` function uses the `js-tiktoken` library and supports all models that have tiktoken encodings.

### Smart Text Preview

Generate intelligent previews of large text blocks that preserve context:

```typescript
import { getSmartPreview } from 'genai-lite/prompting';

const largeCodeFile = `
function calculateTotal(items) {
  let total = 0;
  
  for (const item of items) {
    total += item.price * item.quantity;
  }
  
  return total;
}

function applyDiscount(total, discountPercent) {
  return total * (1 - discountPercent / 100);
}

// ... many more lines of code ...
`;

// Get a preview that shows at least 5 lines but extends to a logical break point
const preview = getSmartPreview(largeCodeFile, { 
  minLines: 5, 
  maxLines: 10 
});
```

The `getSmartPreview` function intelligently truncates text:
- Returns the full content if it's shorter than `maxLines`
- Shows at least `minLines` of content
- Extends to the next blank line (up to `maxLines`) to avoid cutting off in the middle of a code block or paragraph
- Adds `... (content truncated)` when content is truncated

### Example: Building Token-Aware Prompts

Combine these utilities to build prompts that fit within model context windows:

```typescript
import { LLMService, fromEnvironment } from 'genai-lite';
import { countTokens, getSmartPreview } from 'genai-lite/prompting';

const llm = new LLMService(fromEnvironment);

// Large source file
const sourceCode = await fs.readFile('large-file.js', 'utf-8');

// Get a smart preview that fits within token budget
let preview = getSmartPreview(sourceCode, { minLines: 20, maxLines: 50 });
let tokenCount = countTokens(preview, 'gpt-4.1-mini');

// Adjust preview if needed to fit token budget
const maxTokens = 4000;
if (tokenCount > maxTokens) {
  preview = getSmartPreview(sourceCode, { minLines: 10, maxLines: 30 });
}

// Send to LLM
const response = await llm.sendMessage({
  providerId: 'openai',
  modelId: 'gpt-4.1-mini',
  messages: [
    { 
      role: 'user', 
      content: `Analyze this code:\n\n${preview}` 
    }
  ]
});
```

### Template Engine

Generate dynamic prompts and content using the built-in template engine that supports variable substitution and conditional logic:

```typescript
import { renderTemplate } from 'genai-lite/prompting';

// Simple variable substitution
const greeting = renderTemplate('Hello, {{ name }}!', { name: 'World' });
// Result: "Hello, World!"

// Conditional rendering with ternary syntax
const prompt = renderTemplate(
  'Analyze this {{ language }} code:\n{{ hasContext ? `Context: {{context}}\n` : `` }}```\n{{ code }}\n```',
  {
    language: 'TypeScript',
    hasContext: true,
    context: 'React component for user authentication',
    code: 'export const Login = () => { ... }'
  }
);
// Result includes the context line when hasContext is true

// Using logical operators in conditions
const accessControl = renderTemplate(
  '{{ isAuthenticated && !isBanned ? `Welcome {{username}}!` : `Access denied` }}',
  { isAuthenticated: true, isBanned: false, username: 'Alice' }
);
// Result: "Welcome Alice!"

const notification = renderTemplate(
  '{{ hasEmail || hasPhone ? `Contact info available` : `No contact info` }}',
  { hasEmail: false, hasPhone: true }
);
// Result: "Contact info available"

// Complex template with multiple conditionals
const complexTemplate = `
System: You are a {{ role }} assistant.
{{ hasExpertise ? `Expertise: {{expertise}}` : `General knowledge assistant` }}

Task: {{ task }}
{{ hasFiles ? `
Files to analyze:
{{ fileList }}` : `` }}
{{ requiresOutput ? `
Expected output format:
{{ outputFormat }}` : `` }}
`;

const result = renderTemplate(complexTemplate, {
  role: 'coding',
  hasExpertise: true,
  expertise: 'TypeScript, React, Node.js',
  task: 'Review the code for best practices',
  hasFiles: true,
  fileList: '- src/index.ts\n- src/prompting/template.ts',
  requiresOutput: false
});
```

Template syntax supports:
- **Simple substitution**: `{{ variableName }}`
- **Ternary conditionals**: `{{ condition ? `true result` : `false result` }}`
- **Logical operators in conditions**:
  - NOT: `{{ !isDisabled ? `enabled` : `disabled` }}`
  - AND: `{{ hasPermission && isActive ? `show` : `hide` }}`
  - OR: `{{ isAdmin || isOwner ? `allow` : `deny` }}`
  - Combined: `{{ !isDraft && isPublished ? `visible` : `hidden` }}`
- **Nested variables**: `{{ show ? `Name: {{name}}` : `Anonymous` }}`
- **Multi-line strings**: Use backticks to preserve formatting
- **Intelligent newline handling**: Empty results remove trailing newlines

Note: Logical operators support up to 2 operands and don't support parentheses or mixing && and ||.

### Example: Building Dynamic LLM Prompts

Combine the template engine with other utilities for powerful prompt generation:

```typescript
import { LLMService, fromEnvironment } from 'genai-lite';
import { renderTemplate, countTokens } from 'genai-lite/prompting';

const llm = new LLMService(fromEnvironment);

// Define a reusable prompt template
const codeReviewTemplate = `
You are an expert {{ language }} developer.

{{ hasGuidelines ? `Follow these coding guidelines:
{{ guidelines }}

` : `` }}Review the following code:
\`\`\`{{ language }}
{{ code }}
\`\`\`

{{ hasFocus ? `Focus on: {{ focusAreas }}` : `Provide a comprehensive review covering all aspects.` }}
`;

// Render the prompt with specific values
const prompt = renderTemplate(codeReviewTemplate, {
  language: 'TypeScript',
  hasGuidelines: true,
  guidelines: '- Use functional components\n- Prefer composition over inheritance',
  code: sourceCode,
  hasFocus: true,
  focusAreas: 'performance optimizations and error handling'
});

// Check token count before sending
const tokenCount = countTokens(prompt, 'gpt-4.1-mini');
console.log(`Prompt uses ${tokenCount} tokens`);

// Send to LLM
const response = await llm.sendMessage({
  providerId: 'openai',
  modelId: 'gpt-4.1-mini',
  messages: [{ role: 'user', content: prompt }]
});
```

### Prompt Engineering Utilities

genai-lite provides powerful utilities for working with prompts and responses:

#### Creating Messages from Templates

The recommended way to create messages is using `LLMService.createMessages`, which provides a unified API for template rendering, model context injection, and role tag parsing:

```typescript
// Basic multi-turn conversation
const { messages } = await llmService.createMessages({
  template: `
    <SYSTEM>You are a helpful assistant specialized in {{expertise}}.</SYSTEM>
    <USER>Help me with {{task}}</USER>
    <ASSISTANT>I'll help you with {{task}}. Let me analyze the requirements...</ASSISTANT>
    <USER>Can you provide more details?</USER>
  `,
  variables: {
    expertise: 'TypeScript and React',
    task: 'building a custom hook'
  },
  presetId: 'openai-gpt-4.1-default' // Optional: adds model context
});

// Advanced: Adaptive prompts based on model capabilities
const { messages, modelContext } = await llmService.createMessages({
  template: `
    <SYSTEM>
      You are a problem-solving assistant.
      {{ requires_tags_for_thinking ? ' For complex problems, write your reasoning in <thinking> tags before answering.' : '' }}
    </SYSTEM>
    <USER>{{ question }}</USER>
  `,
  // Note: Use requires_tags_for_thinking (NOT operator) - only instruct models that don't have active native reasoning
  variables: { question: 'What causes the seasons on Earth?' },
  presetId: 'anthropic-claude-3-7-sonnet-20250219-thinking'
});

console.log('Model context:', modelContext);
// Output: { native_reasoning_active: true, native_reasoning_capable: true, model_id: 'claude-3-7-sonnet-20250219', ... }
// Note: With a reasoning model, the system prompt won't include thinking tag instructions
```

**Low-Level Utilities:**
For cases where you need template parsing without model context:

```typescript
import { parseRoleTags, renderTemplate } from 'genai-lite/prompting';

// Render variables first
const rendered = renderTemplate(
  '<SYSTEM>You are a {{role}} assistant.</SYSTEM><USER>{{query}}</USER>',
  { role: 'helpful', query: 'What is TypeScript?' }
);

// Then parse role tags
const messages = parseRoleTags(rendered);
// Result: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'What is TypeScript?' }]
```

#### Extracting Random Variables for Few-Shot Learning

Implement few-shot prompting by extracting and shuffling examples:

```typescript
import { extractRandomVariables, renderTemplate } from 'genai-lite/prompting';

// Define examples in your template
const examplesTemplate = `
<RANDOM_INPUT>User: Translate "hello" to Spanish</RANDOM_INPUT>
<RANDOM_OUTPUT>Assistant: The translation of "hello" to Spanish is "hola".</RANDOM_OUTPUT>

<RANDOM_INPUT>User: Translate "goodbye" to French</RANDOM_INPUT>
<RANDOM_OUTPUT>Assistant: The translation of "goodbye" to French is "au revoir".</RANDOM_OUTPUT>

<RANDOM_INPUT>User: Translate "thank you" to German</RANDOM_INPUT>
<RANDOM_OUTPUT>Assistant: The translation of "thank you" to German is "danke".</RANDOM_OUTPUT>
`;

// Extract random variables (shuffled each time)
const variables = extractRandomVariables(examplesTemplate, { maxPerTag: 2 });

// Use in a prompt template
const promptTemplate = `
You are a translation assistant. Here are some examples:

{{ random_input_1 }}
{{ random_output_1 }}

{{ random_input_2 }}
{{ random_output_2 }}

Now translate: "{{word}}" to {{language}}
`;

const prompt = renderTemplate(promptTemplate, {
  ...variables,
  word: 'please',
  language: 'Italian'
});
```

#### Parsing Structured LLM Responses

Extract structured data from LLM responses using custom tags:

```typescript
import { parseStructuredContent } from 'genai-lite/prompting';

// Example LLM response with structured output
const llmResponse = `
Let me analyze this code for you.

<ANALYSIS>
The code has good structure but could benefit from:
1. Better error handling in the API calls
2. Memoization for expensive computations
3. More descriptive variable names
</ANALYSIS>

<SUGGESTIONS>
- Add try-catch blocks around async operations
- Use React.memo() for the expensive component
- Rename 'data' to 'userData' for clarity
</SUGGESTIONS>

<REFACTORED_CODE>
const UserProfile = React.memo(({ userId }) => {
  const [userData, setUserData] = useState(null);
  
  useEffect(() => {
    fetchUserData(userId)
      .then(setUserData)
      .catch(error => console.error('Failed to load user:', error));
  }, [userId]);
  
  return userData ? <Profile data={userData} /> : <Loading />;
});
</REFACTORED_CODE>
`;

// Parse the structured content
const parsed = parseStructuredContent(llmResponse, [
  'ANALYSIS',
  'SUGGESTIONS',
  'REFACTORED_CODE'
]);

console.log(parsed.ANALYSIS);     // The analysis text
console.log(parsed.SUGGESTIONS);  // The suggestions text
console.log(parsed.REFACTORED_CODE); // The refactored code
```

These utilities enable:
- **Structured Conversations**: Build multi-turn conversations from templates with model context awareness
- **Few-Shot Learning**: Randomly sample examples to improve AI responses
- **Reliable Output Parsing**: Extract specific sections from AI responses
- **Automatic Thinking Extraction**: Capture reasoning from any model using XML tags
- **Template Reusability**: Define templates once, use with different variables
- **Type Safety**: Full TypeScript support with LLMMessage types

## Examples

See the **[chat-demo](examples/chat-demo)** application for a complete working example that demonstrates all library features in a production-ready React + Express application.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

### Development

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Run tests (when available)
npm test
```

### End-to-End Testing

The project includes an end-to-end test suite that makes real API calls to providers. These tests are separate from the main unit test suite and are not run in CI by default.

To run these tests locally, you must first provide API keys as environment variables with the `E2E_` prefix:

```bash
export E2E_OPENAI_API_KEY="sk-..."
export E2E_ANTHROPIC_API_KEY="sk-ant-..."
export E2E_GEMINI_API_KEY="AIza..."
```

Then, run the E2E test script:

```bash
npm run test:e2e
```

The tests will automatically skip any provider for which an API key is not found.

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

Originally developed as part of the Athanor project, genai-lite has been extracted and made standalone to benefit the wider developer community.