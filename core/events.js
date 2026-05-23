/** Thin wrapper around native EventTarget so providers can emit typed events. */

if (typeof CustomEvent === 'undefined') {
  class CustomEventPolyfill extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.detail = init.detail;
    }
  }
  // @ts-ignore
  globalThis.CustomEvent = CustomEventPolyfill;
}

export class DfuEventTarget extends EventTarget {
  /** @param {string} type @param {object} detail */
  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
