import {
  HttpSpeechToText,
  HttpTextToSpeech,
  SimulatedSpeechToText,
  SimulatedTextToSpeech,
  loadAssistantProviders,
  type SpeechToTextProvider,
  type TextToSpeechProvider,
} from '@fluvia/assistant';

/**
 * STT y TTS del agente: los MISMOS adaptadores y variables que la API
 * (`ASSISTANT_SPEECH_PROVIDER` + `SPEECH_*`). Sin credenciales, los de prueba
 * (deterministas, etiquetados como tales en la llamada).
 */
export interface AgentSpeech {
  stt: SpeechToTextProvider;
  tts: TextToSpeechProvider;
}

export function agentSpeech(env: Record<string, string | undefined>): AgentSpeech {
  const cfg = loadAssistantProviders(env).speech;
  return cfg.kind === 'openai_compatible'
    ? { stt: new HttpSpeechToText(cfg), tts: new HttpTextToSpeech(cfg) }
    : { stt: new SimulatedSpeechToText(), tts: new SimulatedTextToSpeech() };
}
