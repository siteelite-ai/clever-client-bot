import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SpecificationActions,
  specificationAssistanceFromSlots,
} from "./SpecificationActions";
let root: Root | undefined;
let host: HTMLDivElement | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  host?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function render(managerPhone?: string) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<SpecificationActions managerPhone={managerPhone} />));
}
describe("one manager action, ordinary text input", () => {
  it("offers only the verified telephone link, without clipboard, submit or specify buttons", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render("+77762206220");
    expect(host!.querySelectorAll("button").length).toBe(0);
    expect(host!.querySelectorAll("a").length).toBe(1);
    expect(host!.querySelector("a")!.href).toBe("tel:+77762206220");
    expect(host!.textContent).toBe("Связаться с менеджером");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("uses fixed official contacts if no validated number is available", () => {
    render("javascript:alert(1)");
    expect(host!.querySelector("a")!.href).toBe(
      "https://220volt.kz/kontaktyi/",
    );
    expect(host!.querySelector("a")!.rel).toBe("noopener noreferrer");
  });
  it("keeps only bounded validated contact metadata; ignores legacy summary and arbitrary URL", () => {
    const pending = {
      status: "pending",
      facet_key: "engineering_specification",
      question: "Укажите марку и сечение",
      scope: {
        kind: "selection_readiness",
        assistance: {
          version: 1,
          manager_phone: "+77762206220",
          summary: "legacy",
          contactUrl: "javascript:alert(1)",
        },
      },
    };
    expect(specificationAssistanceFromSlots({ pending_clarification: pending }))
      .toEqual({ question: pending.question, managerPhone: "+77762206220" });
    for (
      const change of [{ question: "" }, { status: "done" }, {
        facet_key: "other",
      }, { scope: { kind: "selection_readiness", assistance: { version: 2 } } }]
    ) {
      expect(
        specificationAssistanceFromSlots({
          pending_clarification: { ...pending, ...change },
        }),
      ).toBeNull();
    }
    expect(
      specificationAssistanceFromSlots({
        pending_clarification: {
          ...pending,
          scope: {
            ...pending.scope,
            assistance: { version: 1, manager_phone: "tel:+123?x" },
          },
        },
      }),
    ).toEqual({ question: pending.question });
  });
});
