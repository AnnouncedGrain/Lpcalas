// Provjera koje kodeke grafička kartica može enkodirati hardverski (bez opterećenja procesora).
// Hardversko enkodiranje je ključno da FPS u igri ne pada dok streamaš.

export type HwCodec = 'h264' | 'av1' | 'vp9' | 'vp8';

const CONTENT_TYPES: Record<HwCodec, string> = {
  h264: 'video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
  av1: 'video/AV1',
  vp9: 'video/VP9',
  vp8: 'video/VP8',
};

export interface CodecSupport {
  codec: HwCodec;
  supported: boolean;
  hardware: boolean; // powerEfficient = enkoder na grafičkoj
  smooth: boolean;
}

const cache = new Map<string, Promise<CodecSupport[]>>();

export function checkEncoders(width: number, height: number, fps: number, bitrate: number): Promise<CodecSupport[]> {
  const key = `${width}x${height}@${fps}:${bitrate}`;
  if (!cache.has(key)) cache.set(key, probe(width, height, fps, bitrate));
  return cache.get(key)!;
}

async function probe(width: number, height: number, fps: number, bitrate: number): Promise<CodecSupport[]> {
  const codecs: HwCodec[] = ['h264', 'av1', 'vp9', 'vp8'];
  return Promise.all(
    codecs.map(async (codec) => {
      try {
        const info = await navigator.mediaCapabilities.encodingInfo({
          type: 'webrtc',
          video: { contentType: CONTENT_TYPES[codec], width, height, bitrate, framerate: fps },
        } as MediaEncodingConfiguration);
        return { codec, supported: info.supported, hardware: info.supported && info.powerEfficient, smooth: info.smooth };
      } catch {
        return { codec, supported: false, hardware: false, smooth: false };
      }
    }),
  );
}

// Redoslijed: H.264 (svi ga mogu gledati, dekodiranje skoro uvijek hardversko), pa AV1, pa VP9.
export async function pickCodec(width: number, height: number, fps: number, bitrate: number): Promise<HwCodec> {
  const list = await checkEncoders(width, height, fps, bitrate);
  for (const c of ['h264', 'av1', 'vp9'] as HwCodec[]) {
    if (list.find((x) => x.codec === c)?.hardware) return c;
  }
  return 'h264';
}

export function gpuName(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return 'nepoznato';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    // "ANGLE (AMD, AMD Radeon RX 7800 XT (0x...) Direct3D11 ...)" -> "AMD Radeon RX 7800 XT"
    const m = /ANGLE \([^,]+, ([^(,]+)/.exec(name);
    return (m ? m[1] : name).trim();
  } catch {
    return 'nepoznato';
  }
}
