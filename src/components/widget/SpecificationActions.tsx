import { useState } from 'react';

export function specificationAssistanceFromSlots(value: unknown): { question: string; summary?: string } | null {
  const slot = (value as {pending_clarification?: {status?:unknown;facet_key?:unknown;question?:unknown;scope?:{kind?:unknown;assistance?:{version?:unknown;summary?:unknown}}}} | null)?.pending_clarification;
  if (slot?.status !== 'pending' || slot.facet_key !== 'engineering_specification' ||
      typeof slot.question !== 'string' || !slot.question.trim() || slot.question.length > 8000 ||
      slot.scope?.kind !== 'selection_readiness' || slot.scope.assistance?.version !== 1) return null;
  const summary = slot.scope.assistance.summary;
  if (summary !== undefined && (typeof summary !== 'string' || !summary.length || summary.length > 4000)) return null;
  return {question:slot.question,...(typeof summary === 'string' ? {summary} : {})};
}

/** Local actions only: no chat request, lead submission or automatic transfer. */
export function SpecificationActions({ summary, onSpecify }: { summary?: string; onSpecify: () => void }) {
  const [status, setStatus] = useState('');
  const chip = 'px-3 py-1.5 rounded-full text-xs font-medium border transition-colors bg-primary/15 text-primary border-primary/30 hover:bg-primary/25';
  return <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Помощь с подбором">
    {summary && <>
      <button type="button" className={chip} onClick={async () => {
        try {
          await navigator.clipboard.writeText(summary);
          setStatus('Условия скопированы');
        } catch {
          setStatus('Не удалось скопировать автоматически. Выделите сводку в сообщении.');
        }
      }}>Скопировать условия</button>
      <a className={chip} href="https://220volt.kz/kontaktyi/" target="_blank" rel="noopener noreferrer">Связаться с менеджером</a>
    </>}
    <button type="button" className={chip} onClick={onSpecify}>Указать марку и сечение</button>
    <span role="status">{status}</span>
  </div>;
}
