import { describe, expect, it } from 'vitest';
import { WriteQueue } from '../src/http/write-queue.js';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('WriteQueue', () => {
  it('sends the first write immediately (leading edge)', async () => {
    const sent: string[] = [];
    const queue = new WriteQueue({ flushMs: 50 });

    void queue.enqueue('brightness', async () => {
      sent.push('first');
    });

    // No waiting for the coalesce window: a tap has to feel instant.
    await tick(5);
    expect(sent).toEqual(['first']);
    queue.close();
  });

  it('collapses a burst so only the newest value per key is sent', async () => {
    const sent: number[] = [];
    const queue = new WriteQueue({ flushMs: 30 });

    // 100 rapid updates, as a slider drag produces.
    for (let i = 0; i < 100; i++) {
      void queue.enqueue('brightness', async () => {
        sent.push(i);
        await tick(2);
      });
    }

    await queue.drain();

    // The leading edge plus a small number of trailing flushes — not 100.
    expect(queue.dispatchedCount).toBeLessThanOrEqual(3);
    // And the value the finger ended on must be the value that lands.
    expect(sent.at(-1)).toBe(99);
    queue.close();
  });

  it('never has more than one request in flight', async () => {
    let concurrent = 0;
    let peak = 0;
    const queue = new WriteQueue({ flushMs: 5 });

    const jobs = Array.from({ length: 20 }, (_, i) =>
      queue.enqueue(`key-${i}`, async () => {
        peak = Math.max(peak, ++concurrent);
        await tick(3);
        concurrent--;
      }),
    );

    await Promise.all(jobs);
    expect(peak).toBe(1);
    queue.close();
  });

  it('keeps distinct keys independent', async () => {
    const sent: string[] = [];
    const queue = new WriteQueue({ flushMs: 5 });

    await Promise.all([
      queue.enqueue('brightness', async () => void sent.push('brightness')),
      queue.enqueue('hue', async () => void sent.push('hue')),
      queue.enqueue('on', async () => void sent.push('on')),
    ]);

    expect(sent.sort()).toEqual(['brightness', 'hue', 'on']);
    queue.close();
  });

  it('resolves superseded writes instead of leaving them hanging', async () => {
    const queue = new WriteQueue({ flushMs: 50 });

    // Occupy the queue so the next two both sit pending.
    void queue.enqueue('blocker', async () => {
      await tick(30);
    });

    const superseded = queue.enqueue('brightness', async () => {});
    const winner = queue.enqueue('brightness', async () => {});

    // A superseded write is not a failure — its intent was subsumed by a newer
    // value, and callers awaiting it should not hang or see a rejection.
    await expect(superseded).resolves.toBeUndefined();
    await expect(winner).resolves.toBeUndefined();
    queue.close();
  });

  it('surfaces errors to the caller and the error handler', async () => {
    const errors: unknown[] = [];
    const queue = new WriteQueue({ flushMs: 5, onError: (e) => errors.push(e) });

    await expect(
      queue.enqueue('boom', async () => {
        throw new Error('device said no');
      }),
    ).rejects.toThrow('device said no');

    expect(errors).toHaveLength(1);
    queue.close();
  });

  it('keeps draining after a failure', async () => {
    const sent: string[] = [];
    const queue = new WriteQueue({ flushMs: 5, onError: () => {} });

    void queue.enqueue('bad', async () => {
      throw new Error('nope');
    }).catch(() => {});
    await queue.enqueue('good', async () => void sent.push('good'));

    expect(sent).toEqual(['good']);
    queue.close();
  });

  it('settles everything pending when closed', async () => {
    const queue = new WriteQueue({ flushMs: 1000 });
    void queue.enqueue('blocker', async () => {
      await tick(20);
    });
    const pending = queue.enqueue('later', async () => {});
    queue.close();
    await expect(pending).resolves.toBeUndefined();
  });
});
