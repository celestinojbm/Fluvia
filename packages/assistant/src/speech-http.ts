import type {
  SpeechAudio,
  SpeechToTextProvider,
  TextToSpeechProvider,
  Transcription,
} from './providers.js';
import { ProviderError } from './providers.js';

/**
 * Voz por una API compatible con la de audio de OpenAI (contrato tomado de su
 * especificación OpenAPI oficial): POST {base}/audio/transcriptions
 * (multipart: file, model, language → {text}) y POST {base}/audio/speech
 * (JSON: model, input ≤ 4096, voice, response_format: wav). El proveedor
 * concreto lo elige el despliegue (SPEECH_BASE_URL); la clave queda en el
 * servidor.
 */
interface Cfg {
  apiKey: string;
  baseUrl: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
}

const EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
};

function fail(status: number): never {
  throw new ProviderError(
    status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate_limited' : 'unavailable'
  );
}

export class HttpSpeechToText implements SpeechToTextProvider {
  readonly name = 'openai_compatible';
  readonly simulated = false;
  constructor(
    private readonly cfg: Cfg,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async transcribe(
    audio: { data: Buffer; mime: string },
    signal: AbortSignal
  ): Promise<Transcription> {
    const form = new FormData();
    form.set(
      'file',
      new Blob([new Uint8Array(audio.data)], { type: audio.mime }),
      `nota.${EXT[audio.mime] ?? 'bin'}`
    );
    form.set('model', this.cfg.sttModel);
    form.set('language', 'es');
    const res = await this.fetchImpl(
      `${this.cfg.baseUrl.replace(/\/$/, '')}/audio/transcriptions`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${this.cfg.apiKey}` },
        body: form,
        signal,
      }
    ).catch(() => fail(0));
    if (!res.ok) fail(res.status);
    const body = (await res.json()) as { text?: unknown };
    return { text: typeof body.text === 'string' ? body.text.trim() : '', language: 'es' };
  }
}

export class HttpTextToSpeech implements TextToSpeechProvider {
  readonly name = 'openai_compatible';
  readonly simulated = false;
  constructor(
    private readonly cfg: Cfg,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async synthesize(text: string, signal: AbortSignal): Promise<SpeechAudio> {
    const res = await this.fetchImpl(`${this.cfg.baseUrl.replace(/\/$/, '')}/audio/speech`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.cfg.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.cfg.ttsModel,
        voice: this.cfg.ttsVoice,
        input: text.slice(0, 4096),
        response_format: 'wav',
      }),
      signal,
    }).catch(() => fail(0));
    if (!res.ok) fail(res.status);
    return { data: Buffer.from(await res.arrayBuffer()), mime: 'audio/wav' };
  }
}
