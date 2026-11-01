import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpecificationActions, specificationAssistanceFromSlots } from './SpecificationActions';

let root: Root | undefined;
let host: HTMLDivElement | undefined;
beforeEach(()=>vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true));
afterEach(()=>{if(root)act(()=>root!.unmount());root=undefined;host?.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
function render(summary='Условия: насос 220 В, 6 А; линия 25 м.') {
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
  const specify=vi.fn();act(()=>root!.render(<SpecificationActions summary={summary} onSpecify={specify}/>));
  return specify;
}

describe('specification assistance local UI actions',()=>{
  it('copies exactly the summary and never submits a chat or a lead',async()=>{
    const writeText=vi.fn().mockResolvedValue(undefined),fetchSpy=vi.fn();
    vi.stubGlobal('fetch',fetchSpy);
    Object.defineProperty(navigator,'clipboard',{value:{writeText},configurable:true});
    const specify=render();
    const buttons=host!.querySelectorAll('button');
    await act(async()=>buttons[0].click());
    expect(writeText).toHaveBeenCalledWith('Условия: насос 220 В, 6 А; линия 25 м.');
    expect(host!.querySelector('[role="status"]')!.textContent).toBe('Условия скопированы');
    expect(fetchSpy).not.toHaveBeenCalled();
    act(()=>buttons[1].click());expect(specify).toHaveBeenCalledOnce();
    expect(host!.querySelector('a')!.getAttribute('href')).toBe('https://220volt.kz/kontaktyi/');
    expect(host!.querySelector('a')!.rel).toBe('noopener noreferrer');
  });
  it('reports clipboard rejection without claiming successful copy',async()=>{
    Object.defineProperty(navigator,'clipboard',{value:{writeText:vi.fn().mockRejectedValue(new Error('denied'))},configurable:true});
    render();await act(async()=>host!.querySelector('button')!.click());
    expect(host!.querySelector('[role="status"]')!.textContent).toMatch(/Не удалось/);
    expect(host!.querySelector('[role="status"]')!.textContent).not.toMatch(/Условия скопированы/);
  });
  it('accepts only bounded versioned specification slots, not an arbitrary payload URL',()=>{
    const pending={status:'pending',facet_key:'engineering_specification',question:'Укажите марку и сечение',scope:{kind:'selection_readiness',assistance:{version:1,summary:'Ток 6 А',contactUrl:'javascript:alert(1)'}}};
    expect(specificationAssistanceFromSlots({pending_clarification:pending})).toEqual({question:pending.question,summary:'Ток 6 А'});
    for(const change of [{question:''},{status:'done'},{facet_key:'other'},{scope:{kind:'selection_readiness',assistance:{version:2}}}]) expect(specificationAssistanceFromSlots({pending_clarification:{...pending,...change}})).toBeNull();
    expect(specificationAssistanceFromSlots({pending_clarification:{...pending,scope:{...pending.scope,assistance:{version:1,summary:'x'.repeat(4001)}}}})).toBeNull();
  });
});
