import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { AudioSource, AudioSourceHandlers } from '@soniox/client';
import { MicError, SharedMic } from '../../src/web/audio/mic';
import { SonioxCapture } from '../../src/web/audio/soniox-session';

const sdk = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('@soniox/client', () => ({ SonioxClient: class { realtime = { record: sdk.record }; } }));
vi.mock('../../src/web/audio/consent', () => ({ listeningConsent: async () => true }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class Recording {
  state = 'recording';
  cancel = vi.fn();
  private handlers = new Map<string, (data: never) => void>();
  on(event: string, handler: (data: never) => void) { this.handlers.set(event, handler); }
  emit(event: string, data: unknown) { this.handlers.get(event)?.(data as never); }
}

function microphone() {
  const source: AudioSource = {
    async start(handlers: AudioSourceHandlers) { handlers.onData(new ArrayBuffer(2)); },
    stop: vi.fn(),
  };
  return {
    live: true,
    suspended: false,
    close: vi.fn(),
    resume: vi.fn(async () => true),
    streamSource: vi.fn(() => ({ source, pcm: false })),
  };
}
type TestMic = ReturnType<typeof microphone>;
const asMic = (mic: TestMic) => mic as unknown as SharedMic;

let open: MockInstance<typeof SharedMic.open>;
let recordings: Recording[];
let captures: SonioxCapture[];
const dom = { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn(), querySelector: () => null };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('document', dom);
  vi.stubGlobal('navigator', { userAgent: 'Chrome', maxTouchPoints: 0 });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Provider calls are forbidden in this test'); }));
  dom.addEventListener.mockClear();
  dom.removeEventListener.mockClear();
  recordings = [];
  captures = [];
  open = vi.spyOn(SharedMic, 'open');
  sdk.record.mockReset().mockImplementation(({ source }: { source: AudioSource }) => {
    const recording = new Recording();
    recordings.push(recording);
    void source.start({ onData: () => undefined, onError: () => undefined, onMuted: () => undefined, onUnmuted: () => undefined });
    return recording;
  });
});

afterEach(() => {
  captures.forEach(capture => capture.stop());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function reader() {
  const send = vi.fn();
  const status = vi.fn();
  const capture = new SonioxCapture(send, status, () => undefined);
  captures.push(capture);
  return { capture, send, status };
}

async function pendingStart(capture: SonioxCapture) {
  const mic = deferred<SharedMic>();
  open.mockReturnValueOnce(mic.promise);
  const completion = capture.start(null);
  await Promise.resolve(); // the consent stand-in resolves before microphone acquisition
  return { ...mic, completion };
}

async function start(capture: SonioxCapture, mic = microphone()) {
  open.mockResolvedValueOnce(asMic(mic));
  await capture.start(null);
  recordings.at(-1)!.emit('state_change', { new_state: 'recording' });
  return mic;
}

async function settleOld(old: ReturnType<typeof deferred<SharedMic>> & { completion: Promise<void> }, answer: string, mic: TestMic) {
  if (answer === 'grant') old.resolve(asMic(mic));
  else old.reject(new MicError('permission', 'Old request denied'));
  await old.completion;
}

describe('microphone ownership across cancelled capture attempts', () => {
  it.each(['grant', 'denial'])('ignores an old %s after Stop and a successful retry', async answer => {
    const { capture, send, status } = reader();
    const old = await pendingStart(capture);
    capture.stop();
    const current = await start(capture);
    const epoch = capture.captureEpoch;
    const messageCount = send.mock.calls.length;
    const discarded = microphone();
    await settleOld(old, answer, discarded);

    expect(capture.listening).toBe(true);
    expect(status.mock.lastCall?.[0]).toEqual({ state: 'recording', detail: null });
    expect(capture.captureEpoch).toBe(epoch);
    expect(send).toHaveBeenCalledTimes(messageCount);
    expect(sdk.record).toHaveBeenCalledTimes(1);
    expect(current.close).not.toHaveBeenCalled();
    expect(discarded.close).toHaveBeenCalledTimes(answer === 'grant' ? 1 : 0);
    capture.stop();
    expect(current.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['grant', 'denial'])('keeps Stop final when a pending request later returns %s', async answer => {
    const { capture, send, status } = reader();
    const old = await pendingStart(capture);
    capture.stop();
    const messageCount = send.mock.calls.length;
    const discarded = microphone();
    await settleOld(old, answer, discarded);
    expect(capture.listening).toBe(false);
    expect(status.mock.lastCall?.[0]).toEqual({ state: 'off', detail: null });
    expect(send).toHaveBeenCalledTimes(messageCount);
    expect(sdk.record).not.toHaveBeenCalled();
    expect(discarded.close).toHaveBeenCalledTimes(answer === 'grant' ? 1 : 0);
  });

  it.each(['grant', 'denial'])('ignores an old %s while the explicit retry is still pending', async answer => {
    const { capture, send, status } = reader();
    const old = await pendingStart(capture);
    capture.stop();
    const current = await pendingStart(capture);
    const messageCount = send.mock.calls.length;
    await settleOld(old, answer, microphone());
    expect(status.mock.lastCall?.[0]).toEqual({ state: 'starting', detail: null });
    expect(send).toHaveBeenCalledTimes(messageCount);
    expect(sdk.record).not.toHaveBeenCalled();
    const mic = microphone();
    current.resolve(asMic(mic));
    await current.completion;
    expect(capture.listening).toBe(true);
    expect(sdk.record).toHaveBeenCalledTimes(1);
    capture.stop();
    expect(mic.close).toHaveBeenCalledTimes(1);
  });

  it('still reports a current permission denial and permits an explicit retry', async () => {
    const { capture, status } = reader();
    const attempt = await pendingStart(capture);
    attempt.reject(new MicError('permission', 'Current request denied'));
    await attempt.completion;
    expect(capture.listening).toBe(false);
    expect(status.mock.lastCall?.[0].state).toBe('error');
    expect(status.mock.lastCall?.[0].detail).toContain('browser’s site settings');
    await start(capture);
    expect(capture.listening).toBe(true);
  });

  it('drops voice, pause and microphone-change callbacks from a discarded request', async () => {
    const { capture, send, status } = reader();
    const old = await pendingStart(capture);
    const callbacks = open.mock.calls[0];
    capture.stop();
    const current = await start(capture);
    const messageCount = send.mock.calls.length;
    callbacks[3]!(false);
    callbacks[4]!();
    callbacks[2]('quiet');
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(messageCount);
    expect(recordings[0].cancel).not.toHaveBeenCalled();
    expect(current.resume).not.toHaveBeenCalled();
    expect(status.mock.lastCall?.[0].state).toBe('recording');
    old.resolve(asMic(microphone()));
    await old.completion;
  });

  it('keeps the current microphone callbacks working across provider restarts', async () => {
    const { capture, status } = reader();
    const mic = await start(capture);
    const callbacks = open.mock.calls[0];
    const epoch = capture.captureEpoch;
    recordings[0].emit('session_restart', {});
    expect(capture.captureEpoch).toBeGreaterThan(epoch);
    callbacks[2]('quiet');
    expect(status.mock.lastCall?.[0].state).toBe('dozing');
    callbacks[2]('voice');
    expect(sdk.record).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledTimes(1);
    expect(mic.close).not.toHaveBeenCalled();
  });

  it.each(['grant', 'denial'])('ignores a replaced-microphone recovery %s after Stop and retry', async answer => {
    const { capture, send, status } = reader();
    const expired = await start(capture);
    expired.live = false;
    const recovery = deferred<SharedMic>();
    open.mockReturnValueOnce(recovery.promise);
    open.mock.calls[0][4]!(); // the system-ended microphone asks the real capture owner to recover
    capture.stop();
    const current = await start(capture);
    const messageCount = send.mock.calls.length;
    const discarded = microphone();
    if (answer === 'grant') recovery.resolve(asMic(discarded));
    else recovery.reject(new MicError('permission', 'Old recovery denied'));
    await vi.advanceTimersByTimeAsync(0);
    expect(capture.listening).toBe(true);
    expect(status.mock.lastCall?.[0].state).toBe('recording');
    expect(current.close).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(messageCount);
    expect(sdk.record).toHaveBeenCalledTimes(2);
    expect(discarded.close).toHaveBeenCalledTimes(answer === 'grant' ? 1 : 0);
  });

  it('replaces an ended microphone and keeps callbacks owned by its replacement', async () => {
    const { capture, send, status } = reader();
    const previous = await start(capture);
    const replacement = microphone();
    previous.live = false;
    open.mockResolvedValueOnce(asMic(replacement));
    const oldCallbacks = open.mock.calls[0];
    oldCallbacks[4]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(previous.close).toHaveBeenCalledTimes(1);
    expect(sdk.record).toHaveBeenCalledTimes(2);
    recordings[1].emit('state_change', { new_state: 'recording' });
    const messageCount = send.mock.calls.length;
    oldCallbacks[3]!(false);
    oldCallbacks[4]!();
    oldCallbacks[2]('quiet');
    expect(send).toHaveBeenCalledTimes(messageCount);
    expect(recordings[1].cancel).not.toHaveBeenCalled();
    expect(replacement.resume).not.toHaveBeenCalled();
    open.mock.calls[1][2]('quiet');
    expect(status.mock.lastCall?.[0].state).toBe('dozing');
    capture.stop();
    expect(replacement.close).toHaveBeenCalledTimes(1);
  });

  it('reports a current recovery denial and closes that session microphone', async () => {
    const { capture, status } = reader();
    const previous = await start(capture);
    previous.live = false;
    open.mockRejectedValueOnce(new MicError('permission', 'Recovery denied'));
    open.mock.calls[0][4]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(capture.listening).toBe(false);
    expect(status.mock.lastCall?.[0].state).toBe('error');
    expect(status.mock.lastCall?.[0].detail).toContain('Microphone permission was denied');
    expect(previous.close).toHaveBeenCalledTimes(1);
  });

  it('closes its replacement if a waiting session cannot start the recovered stream', async () => {
    const { capture, status } = reader();
    const previous = await start(capture);
    recordings[0].emit('error', { raw: { error_type: 'listening_busy' } });
    expect(status.mock.lastCall?.[0].state).toBe('waiting');
    previous.live = false;
    const replacement = microphone();
    open.mockResolvedValueOnce(asMic(replacement));
    sdk.record.mockImplementationOnce(() => { throw new Error('Recovered stream unavailable'); });
    open.mock.calls[0][4]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(capture.listening).toBe(false);
    expect(status.mock.lastCall?.[0]).toEqual({ state: 'error', detail: 'Recovered stream unavailable' });
    expect(previous.close).toHaveBeenCalledTimes(1);
    expect(replacement.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['suspended', 'rejected'])('ignores an old audio resume that returns %s after retry', async answer => {
    const { capture, status } = reader();
    const previous = await start(capture);
    const resume = deferred<boolean>();
    previous.resume.mockReturnValueOnce(resume.promise);
    previous.suspended = true;
    open.mock.calls[0][4]!();
    capture.stop();
    const current = await start(capture);
    if (answer === 'suspended') resume.resolve(false);
    else resume.reject(new Error('Old audio context failed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(capture.listening).toBe(true);
    expect(status.mock.lastCall?.[0]).toEqual({ state: 'recording', detail: null });
    expect(current.close).not.toHaveBeenCalled();
    expect(dom.addEventListener.mock.calls.some(([event]) => event === 'pointerup')).toBe(false);
  });

  it('lets only the current recovery clear its pending flag', async () => {
    const { capture } = reader();
    const previous = await start(capture);
    const oldResume = deferred<boolean>();
    previous.resume.mockReturnValueOnce(oldResume.promise);
    previous.suspended = true;
    open.mock.calls[0][4]!();
    capture.stop();
    const current = await start(capture);
    const newResume = deferred<boolean>();
    current.resume.mockReturnValueOnce(newResume.promise);
    current.suspended = true;
    open.mock.calls[1][4]!();
    expect(current.resume).toHaveBeenCalledTimes(1);
    oldResume.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    open.mock.calls[1][4]!();
    expect(current.resume).toHaveBeenCalledTimes(1);
    current.suspended = false;
    newResume.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
  });
});
