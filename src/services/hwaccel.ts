import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { logger } from '../lib/logger.ts';
import { runCommand } from './subtitles.ts';

/**
 * Hardware encode autodetection, Jellyfin-style: `ffmpeg -encoders` only tells us what was
 * compiled in. Every candidate also gets a real one-frame encode so a missing driver, absent
 * device node, or broken firmware never reaches a playback session.
 */
export type HwAccelKind = 'nvenc' | 'qsv' | 'vaapi' | 'amf' | 'v4l2m2m' | 'rkmpp' | 'vulkan' | 'videotoolbox';

export interface HwEncoder {
  kind: HwAccelKind;
  encoder: string;
  device: string | null;
  label: string;
  /** Hardware decode path that pairs with this encoder, when known. */
  decode: 'cuda' | 'vaapi' | 'qsv' | 'v4l2m2m' | 'rkmpp' | null;
  /** libva driver name for multi-GPU hosts (radeonsi/iHD). */
  driver: string | null;
}

export interface HwRejection {
  kind: HwAccelKind;
  encoder: string;
  device: string | null;
  reason: string;
}

export interface HwAccelReport {
  detectedAt: string;
  ffmpeg: string;
  encoders: HwEncoder[];
  rejected: HwRejection[];
  softwareAvailable: boolean;
  notes: string[];
}

export interface SelectedEncoder {
  kind: HwAccelKind | 'software';
  encoder: string;
  device: string | null;
  decode: HwEncoder['decode'];
  driver: string | null;
  hardware: boolean;
}

const KIND_RANK: Record<HwAccelKind, number> = {
  nvenc: 100,
  videotoolbox: 98,
  qsv: 96,
  rkmpp: 94,
  vaapi: 90,
  amf: 60,
  v4l2m2m: 55,
  vulkan: 45,
};

const KIND_LABEL: Record<HwAccelKind, string> = {
  nvenc: 'NVIDIA NVENC',
  qsv: 'Intel Quick Sync',
  vaapi: 'VAAPI',
  amf: 'AMD AMF',
  v4l2m2m: 'V4L2 mem2mem',
  rkmpp: 'Rockchip MPP',
  vulkan: 'Vulkan Video',
  videotoolbox: 'Apple VideoToolbox',
};

const CANDIDATES: Array<{ kind: HwAccelKind; encoder: string; decode: HwEncoder['decode']; platforms?: NodeJS.Platform[] }> = [
  { kind: 'nvenc', encoder: 'h264_nvenc', decode: 'cuda' },
  { kind: 'qsv', encoder: 'h264_qsv', decode: 'qsv' },
  { kind: 'vaapi', encoder: 'h264_vaapi', decode: 'vaapi' },
  { kind: 'amf', encoder: 'h264_amf', decode: null, platforms: ['win32'] },
  { kind: 'v4l2m2m', encoder: 'h264_v4l2m2m', decode: 'v4l2m2m', platforms: ['linux'] },
  { kind: 'rkmpp', encoder: 'h264_rkmpp', decode: 'rkmpp', platforms: ['linux'] },
  { kind: 'vulkan', encoder: 'h264_vulkan', decode: null },
  { kind: 'videotoolbox', encoder: 'h264_videotoolbox', decode: null, platforms: ['darwin'] },
];

const CACHE_TTL_MS = 30 * 60_000;
const CACHE_FILE = path.join(config.cacheDir, 'hwaccel.json');
const failed = new Set<string>();

let report: HwAccelReport | null = null;
let pending: Promise<HwAccelReport> | null = null;

export function hwAccelKinds(): HwAccelKind[] {
  return CANDIDATES.map((entry) => entry.kind);
}

export function isHwAccelKind(value: string): value is HwAccelKind {
  return (hwAccelKinds() as string[]).includes(value);
}

function encoderKey(kind: HwAccelKind, encoder: string, device: string | null): string {
  return `${kind}:${encoder}:${device || 'default'}`;
}

/** Device nodes worth probing for VAAPI. Never hardcode renderD128; laptops have several. */
interface VaapiDevice {
  device: string | null;
  driver: string | null;
}

function vaapiDevices(): VaapiDevice[] {
  if (process.platform !== 'linux') return [];
  let names: string[];
  try {
    names = fs.readdirSync('/dev/dri').filter((name) => /^renderD\d+$/.test(name));
  } catch {
    return [];
  }
  names.sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
  return names.map((name) => {
    let kernelDriver = '';
    try {
      kernelDriver = /DRIVER=([\w-]+)/.exec(fs.readFileSync(`/sys/class/drm/${name}/device/uevent`, 'utf8'))?.[1] || '';
    } catch {
      /* no sysfs entry: probe without an explicit libva driver */
    }
    // VAAPI is not implemented for NVIDIA's proprietary stack; the render node exists, the
    // driver does not. Mapping the common Intel/AMD kernel drivers avoids libva guesswork.
    const driver = kernelDriver === 'amdgpu' ? 'radeonsi' : kernelDriver === 'i915' || kernelDriver === 'xe' ? 'iHD' : null;
    return { device: `/dev/dri/${name}`, driver };
  });
}

function fileExists(target: string): boolean {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

function socDescription(): string {
  try {
    const model = fs.readFileSync('/proc/device-tree/model', 'utf8').replace(/\0/g, '').trim();
    const compatible = fs.readFileSync('/proc/device-tree/compatible', 'utf8').replace(/\0/g, ' ');
    return `${model} ${compatible}`.toLowerCase();
  } catch {
    return '';
  }
}

function parseEncoderList(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of stdout.split('\n')) {
    const match = /^\s*[VAS][\w.]{5}\s+(\S+)/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

async function probeEncoder(kind: HwAccelKind, encoder: string, device: string | null, driver: string | null = null): Promise<{ ok: boolean; reason: string }> {
  const args: string[] = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (kind === 'vaapi') args.push('-init_hw_device', `vaapi=hw:${device}`, '-filter_hw_device', 'hw');
  if (kind === 'qsv') args.push('-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw');
  if (kind === 'rkmpp') args.push('-init_hw_device', 'rkmpp=hw', '-filter_hw_device', 'hw');
  if (kind === 'vulkan') args.push('-init_hw_device', 'vulkan=hw', '-filter_hw_device', 'hw');
  args.push('-f', 'lavfi', '-i', 'testsrc2=size=256x144:rate=10', '-frames:v', '5');
  if (kind === 'vaapi' || kind === 'vulkan') args.push('-vf', 'format=nv12,hwupload');
  if (kind === 'rkmpp') args.push('-vf', 'format=nv12,hwupload');
  if (kind === 'v4l2m2m') args.push('-vf', 'format=yuv420p');
  args.push('-c:v', encoder, '-f', 'null', '-');
  const env = driver ? { ...process.env, LIBVA_DRIVER_NAME: driver } : undefined;
  const result = await runCommand(config.ffmpegPath, args, { lane: 'probe', timeoutMs: 20_000, maxBytes: 16 * 1024, env });
  if (result.code === 0) return { ok: true, reason: '' };
  const reason = result.timedOut
    ? 'timed out'
    : (result.stderr || '').trim().split('\n').slice(-1)[0]?.slice(0, 240) || `exit ${result.code}`;
  return { ok: false, reason };
}

function readCachedReport(): HwAccelReport | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as HwAccelReport;
    if (!parsed?.detectedAt || !Array.isArray(parsed.encoders)) return null;
    if (Date.now() - Date.parse(parsed.detectedAt) > CACHE_TTL_MS) return null;
    if (parsed.ffmpeg !== config.ffmpegPath) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCachedReport(value: HwAccelReport): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(value, null, 2));
  } catch {
    /* cache is optional */
  }
}

async function runDetection(): Promise<HwAccelReport> {
  const encoders = new Set<string>();
  const rejected: HwRejection[] = [];
  const notes: string[] = [];
  const ffmpegReport = await runCommand(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-encoders'], {
    lane: 'probe',
    timeoutMs: 15_000,
    maxBytes: 512 * 1024,
  });
  if (ffmpegReport.code !== 0) {
    return {
      detectedAt: new Date().toISOString(),
      ffmpeg: config.ffmpegPath,
      encoders: [],
      rejected,
      softwareAvailable: false,
      notes: ['ffmpeg could not list encoders; hardware acceleration unavailable.'],
    };
  }
  for (const name of parseEncoderList(ffmpegReport.stdout)) encoders.add(name);
  const softwareAvailable = encoders.has('libx264');
  if (!softwareAvailable) notes.push('libx264 is missing; software H.264 transcoding will fail.');

  const devices = vaapiDevices();
  if (process.platform === 'linux' && devices.length === 0) notes.push('No /dev/dri render nodes found; VAAPI and Vulkan encode cannot run.');
  if (process.platform === 'linux' && !fileExists('/dev/mpp_service') && encoders.has('h264_rkmpp')) {
    notes.push('Rockchip MPP encoder found but /dev/mpp_service is missing.');
  }

  const working: HwEncoder[] = [];
  for (const candidate of CANDIDATES) {
    if (candidate.platforms && !candidate.platforms.includes(process.platform)) continue;
    if (!encoders.has(candidate.encoder)) {
      rejected.push({ kind: candidate.kind, encoder: candidate.encoder, device: null, reason: 'encoder not compiled into ffmpeg' });
      continue;
    }
    const deviceList: VaapiDevice[] = candidate.kind === 'vaapi' ? devices : [{ device: null, driver: null }];
    if (candidate.kind === 'vaapi' && deviceList.length === 0) {
      rejected.push({ kind: candidate.kind, encoder: candidate.encoder, device: null, reason: 'no /dev/dri render node' });
      continue;
    }
    for (const entry of deviceList) {
      if (failed.has(encoderKey(candidate.kind, candidate.encoder, entry.device))) {
        rejected.push({ kind: candidate.kind, encoder: candidate.encoder, device: entry.device, reason: 'failed at runtime; retry after restart' });
        continue;
      }
      const result = await probeEncoder(candidate.kind, candidate.encoder, entry.device, entry.driver);
      if (result.ok) {
        working.push({
          kind: candidate.kind,
          encoder: candidate.encoder,
          device: entry.device,
          label: `${KIND_LABEL[candidate.kind]}${entry.device ? ` (${entry.device})` : ''}`,
          decode: candidate.decode,
          driver: entry.driver,
        });
      } else {
        rejected.push({ kind: candidate.kind, encoder: candidate.encoder, device: entry.device, reason: result.reason });
      }
    }
  }
  working.sort((a, b) => KIND_RANK[b.kind] - KIND_RANK[a.kind]);
  const soc = socDescription();
  const hasWorking = (kind: HwAccelKind): boolean => working.some((entry) => entry.kind === kind);
  if (soc.includes('rk3588') && !hasWorking('rkmpp')) {
    notes.push('Rockchip RK3588 detected without a working RKMPP encoder. Install jellyfin-ffmpeg (--enable-rkmpp) and set FFMPEG_PATH, or transcoding falls back to the CPU.');
  }
  if (soc.includes('raspberry pi')) {
    if (!hasWorking('v4l2m2m') && soc.includes('bcm2711')) {
      notes.push('Raspberry Pi 4 detected; expose the V4L2 H.264 encoder (/dev/video11) to use h264_v4l2m2m. Otherwise software x264 is used.');
    } else if (!hasWorking('v4l2m2m') && !hasWorking('vaapi') && (soc.includes('bcm2712') || soc.includes('raspberry pi 5'))) {
      notes.push('Raspberry Pi 5 detected; mainline ffmpeg has no usable hardware encoder, so output is software x264 (hardware HEVC decode does not help encoding).');
    }
  }
  if ((soc.includes('cix') || soc.includes('orangepi 6')) && working.length === 0) {
    notes.push('Orange Pi 6 / CIX P1 has no mainline ffmpeg video encoder yet; software x264 is the honest path.');
  }
  if (process.platform === 'linux' && fileExists('/dev/nvidiactl') && !hasWorking('nvenc')) {
    notes.push('NVIDIA device present but ffmpeg has no working NVENC encoder. Use an ffmpeg build with NVENC (jellyfin-ffmpeg) via FFMPEG_PATH.');
  }
  const value: HwAccelReport = {
    detectedAt: new Date().toISOString(),
    ffmpeg: config.ffmpegPath,
    encoders: working,
    rejected,
    softwareAvailable,
    notes,
  };
  logger.info('transcode', 'Hardware acceleration probe finished', {
    working: working.map((entry) => entry.label),
    rejected: rejected.length,
  });
  return value;
}

/** Detect once per process, with a disk cache so restarts do not re-probe every GPU. */
export function detectHwAccel(force = false): Promise<HwAccelReport> {
  if (force) failed.clear();
  if (!force && report) return Promise.resolve(report);
  if (pending) return pending;
  const cached = force ? null : readCachedReport();
  if (cached) {
    report = cached;
    return Promise.resolve(cached);
  }
  pending = runDetection()
    .then((value) => {
      report = value;
      writeCachedReport(value);
      return value;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('transcode', 'Hardware acceleration probe failed', { message });
      report = {
        detectedAt: new Date().toISOString(),
        ffmpeg: config.ffmpegPath,
        encoders: [],
        rejected: [],
        softwareAvailable: false,
        notes: [`probe failed: ${message}`],
      };
      return report;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

export function cachedHwAccel(): HwAccelReport | null {
  return report;
}

/** Runtime failures demote an encoder for this process so the next session does not repeat the crash. */
export function markHwAccelFailed(selection: SelectedEncoder, reason: string): void {
  if (selection.hardware) {
    failed.add(encoderKey(selection.kind as HwAccelKind, selection.encoder, selection.device));
    logger.warn('transcode', 'Hardware encoder failed; falling back to software', { encoder: selection.encoder, reason: reason.slice(0, 200) });
  }
  if (report) {
    report.encoders = report.encoders.filter((entry) => !(entry.kind === selection.kind && entry.encoder === selection.encoder && entry.device === selection.device));
  }
}

export function selectSoftwareEncoder(): SelectedEncoder {
  return { kind: 'software', encoder: 'libx264', device: null, decode: null, driver: null, hardware: false };
}

/**
 * Pick the best working encoder for the requested mode. `auto` follows Jellyfin's vendor
 * preference order; explicit modes still fall back to software instead of failing playback.
 */
export function selectEncoder(values: HwAccelReport, preference: string, deviceOverride: string): SelectedEncoder {
  if (preference === 'none') return selectSoftwareEncoder();
  const available = values.encoders.filter((entry) => !failed.has(encoderKey(entry.kind, entry.encoder, entry.device)));
  if (preference !== 'auto' && isHwAccelKind(preference)) {
    const exact = available.filter((entry) => entry.kind === preference && (entry.kind !== 'vaapi' || !deviceOverride || entry.device === deviceOverride));
    if (exact[0]) return { ...exact[0], hardware: true };
    return selectSoftwareEncoder();
  }
  const best = available.find((entry) => entry.kind !== 'vaapi' || !deviceOverride || entry.device === deviceOverride) || available[0];
  return best ? { ...best, hardware: true } : selectSoftwareEncoder();
}
