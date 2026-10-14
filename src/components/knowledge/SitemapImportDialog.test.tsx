import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SitemapImportDialog } from './SitemapImportDialog';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { functions: { invoke: mocks.invoke } },
}));

vi.mock('sonner', () => ({
  toast: {
    success: mocks.success,
    info: mocks.info,
    warning: mocks.warning,
    error: mocks.error,
  },
}));

async function fetchSitemap(response: Record<string, unknown>) {
  mocks.invoke.mockResolvedValueOnce({ data: response, error: null });
  render(<SitemapImportDialog onImportComplete={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Sitemap XML' }));
  const input = screen.getByPlaceholderText('https://220volt.kz/sitemap.xml');
  fireEvent.change(input, { target: { value: 'https://example.com/sitemap.xml' } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalled());
}

describe('SitemapImportDialog partial results', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('warns about a truncated sitemap and scopes select-all to found pages', async () => {
    await fetchSitemap({
      success: true,
      urls: ['https://example.com/a'],
      truncated: true,
      skippedSitemaps: 0,
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Достигнут лимит обработки sitemap');
    expect(screen.getByRole('button', { name: 'Выбрать найденные' })).toBeInTheDocument();
    expect(mocks.warning).toHaveBeenCalledWith('Список может быть неполным. Найдено страниц: 1');
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it('warns when nested sitemaps are skipped even if no page was found', async () => {
    await fetchSitemap({ success: true, urls: [], skippedSitemaps: 2 });

    expect(await screen.findByRole('alert')).toHaveTextContent('пропущено: 2');
    expect(mocks.warning).toHaveBeenCalledWith('Список может быть неполным. Найдено страниц: 0');
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it('keeps the old response format as a complete result', async () => {
    await fetchSitemap({ success: true, urls: ['https://example.com/a'] });

    expect(await screen.findByRole('button', { name: 'Выбрать все' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mocks.success).toHaveBeenCalledWith('Найдено страниц: 1');
    expect(mocks.warning).not.toHaveBeenCalled();
  });
});
