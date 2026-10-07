import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatWidget } from './ChatWidget';

const optionReplies = [
  { value: 'До 4 м', label: 'Низко: до 4 м' },
  { value: 'Выше 4 м', label: 'Высоко: более 4 м' },
];

const pendingSlot = (options: { value: string; label: string }[]) => ({
  pending_clarification: {
    status: 'pending', slot_id: 'slot-1', facet_key: 'mounting_height',
    question: 'На какой высоте установите прожектор?', options,
  },
});

const clarificationEvents = (
  options = optionReplies,
  { done = true, error = null }: { done?: boolean; error?: string | null } = {},
) => [
  { v3_event: { type: 'delta', content: 'На какой высоте установите прожектор?' } },
  ...(options.length ? [{ v3_event: {
    type: 'quick_replies', facet_key: 'mounting_height', replies: optionReplies,
  } }] : []),
  { v3_event: { type: 'slot_update', slots: pendingSlot(options) } },
  { v3_event: { type: 'diagnostic', phase: 'complete', log_id: 'log-1', error } },
  ...(done ? ['[DONE]'] : []),
];

const sseResponse = (events: (object | string)[]) => {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${event === '[DONE]' ? event : JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};

const sendInitial = () => {
  const input = screen.getByPlaceholderText('Напишите сообщение...');
  fireEvent.change(input, { target: { value: 'Нужен прожектор во двор' } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
  return input;
};

beforeEach(() => {
  let nextId = 0;
  vi.stubGlobal('crypto', { randomUUID: () => `test-${++nextId}` });
});

afterEach(() => vi.unstubAllGlobals());

describe('React widget clarification choices', () => {
  it('finishes at [DONE] even when a proxy keeps the transport open', async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream({
      start(controller) {
        for (const event of clarificationEvents()) {
          controller.enqueue(encoder.encode(`data: ${event === '[DONE]' ? event : JSON.stringify(event)}\n\n`));
        }
        // Intentionally do not close: this used to keep the widget loading.
      },
      cancel() { cancelled = true; },
    }), { status: 200 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    render(<ChatWidget isPreview />);
    const input = sendInitial();
    await screen.findByRole('button', { name: 'Низко: до 4 м' });
    expect((input as HTMLInputElement).disabled).toBe(false);
    await waitFor(() => expect(cancelled).toBe(true));
  });

  it('waits for the final protocol marker before showing choices', async () => {
    let finish = () => {};
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream({
      start(controller) {
        for (const event of clarificationEvents().filter(event => event !== '[DONE]')) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        finish = () => {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        };
      },
    }), { status: 200 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    render(<ChatWidget isPreview />);
    sendInitial();
    await screen.findByText('На какой высоте установите прожектор?');
    expect(screen.queryByRole('button', { name: 'Низко: до 4 м' })).toBeNull();
    act(() => finish());
    await screen.findByRole('button', { name: 'Низко: до 4 м' });
  });

  it('shows only completed server-matched options and sends the exact value', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse(clarificationEvents()))
      .mockResolvedValueOnce(sseResponse([
        { v3_event: { type: 'delta', content: 'Понял высоту.' } },
        { v3_event: { type: 'diagnostic', phase: 'complete', log_id: 'log-2', error: null } },
        '[DONE]',
      ]));
    vi.stubGlobal('fetch', fetchMock);
    render(<ChatWidget isPreview />);
    sendInitial();
    const chip = await screen.findByRole('button', { name: 'Низко: до 4 м' });
    const custom = screen.getByRole('button', { name: 'Напишу свой вариант' });
    fireEvent.click(custom);
    expect(document.activeElement).toBe(screen.getByPlaceholderText('Напишите сообщение...'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(chip);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).message).toBe('До 4 м');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Высоко: более 4 м' })).toBeNull());
  });

  it('does not show options that differ from the server pending slot', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(clarificationEvents([
      { value: 'Другая высота', label: 'Другая высота' }, optionReplies[1],
    ]))));
    render(<ChatWidget isPreview />);
    sendInitial();
    await screen.findByText('На какой высоте установите прожектор?');
    await waitFor(() => expect(screen.queryByText('Низко: до 4 м')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Напишу свой вариант' })).toBeNull();
  });

  it('does not expose chips from a partial or errored stream', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse(clarificationEvents(optionReplies, { done: false })))
      .mockResolvedValueOnce(sseResponse(clarificationEvents(optionReplies, { error: 'internal_error' })));
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = render(<ChatWidget isPreview />);
    const firstInput = sendInitial();
    await screen.findByText('На какой высоте установите прожектор?');
    await waitFor(() => expect((firstInput as HTMLInputElement).disabled).toBe(false));
    expect(screen.queryByRole('button', { name: 'Низко: до 4 м' })).toBeNull();
    unmount();
    render(<ChatWidget isPreview />);
    const secondInput = sendInitial();
    await screen.findByText('На какой высоте установите прожектор?');
    await waitFor(() => expect((secondInput as HTMLInputElement).disabled).toBe(false));
    expect(screen.queryByRole('button', { name: 'Низко: до 4 м' })).toBeNull();
  });

  it('offers focus-only custom input for a server freeform clarification', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(clarificationEvents([])));
    vi.stubGlobal('fetch', fetchMock);
    render(<ChatWidget isPreview />);
    const input = sendInitial();
    const custom = await screen.findByRole('button', { name: 'Напишу свой вариант' });
    expect(screen.queryByRole('button', { name: 'Низко: до 4 м' })).toBeNull();
    fireEvent.click(custom);
    expect(document.activeElement).toBe(input);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not let an old delayed follow-up erase a newer clarification', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse([
        { v3_event: { type: 'delta', content: 'Первый ответ.' } },
        { followup: { text: 'Старая дополнительная реплика' } },
        { v3_event: { type: 'diagnostic', phase: 'complete', log_id: 'log-old', error: null } },
        '[DONE]',
      ]))
      .mockResolvedValueOnce(sseResponse(clarificationEvents()));
    vi.stubGlobal('fetch', fetchMock);
    render(<ChatWidget isPreview />);
    const input = sendInitial();
    await screen.findByText('Первый ответ.');
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(input, { target: { value: 'Новая тема: прожектор' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    await screen.findByRole('button', { name: 'Низко: до 4 м' });
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(screen.queryByText('Старая дополнительная реплика')).toBeNull();
    expect(screen.getByRole('button', { name: 'Низко: до 4 м' })).toBeTruthy();
  });

  it('does not append a follow-up after a clarification in the same turn', async () => {
    const events: (object | string)[] = clarificationEvents();
    events.splice(events.length - 2, 0, { followup: { text: 'Лишняя реплика' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(events)));
    render(<ChatWidget isPreview />);
    sendInitial();
    await screen.findByRole('button', { name: 'Низко: до 4 м' });
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(screen.queryByText('Лишняя реплика')).toBeNull();
    expect(screen.getByRole('button', { name: 'Низко: до 4 м' })).toBeTruthy();
  });
});
