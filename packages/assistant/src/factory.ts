import { AnthropicConversationProvider } from './anthropic.js';
import type { AssistantProviderConfig } from './config.js';
import { LiveKitCallTransport } from './livekit.js';
import type {
  CallTransport,
  ConversationProvider,
  SpeechToTextProvider,
  TextToSpeechProvider,
} from './providers.js';
import {
  SimulatedCallTransport,
  SimulatedConversationProvider,
  SimulatedSpeechToText,
  SimulatedTextToSpeech,
} from './simulated.js';
import { HttpSpeechToText, HttpTextToSpeech } from './speech-http.js';

export interface AssistantProviders {
  conversation: ConversationProvider;
  stt: SpeechToTextProvider;
  tts: TextToSpeechProvider;
  call: CallTransport;
}

/** Instancia cada proveedor según la configuración; sin credenciales, el simulado. */
export function createAssistantProviders(cfg: AssistantProviderConfig): AssistantProviders {
  return {
    conversation:
      cfg.conversation.kind === 'anthropic'
        ? new AnthropicConversationProvider(cfg.conversation)
        : new SimulatedConversationProvider(),
    stt:
      cfg.speech.kind === 'openai_compatible'
        ? new HttpSpeechToText(cfg.speech)
        : new SimulatedSpeechToText(),
    tts:
      cfg.speech.kind === 'openai_compatible'
        ? new HttpTextToSpeech(cfg.speech)
        : new SimulatedTextToSpeech(),
    call:
      cfg.call.kind === 'livekit'
        ? new LiveKitCallTransport(cfg.call)
        : new SimulatedCallTransport(),
  };
}
