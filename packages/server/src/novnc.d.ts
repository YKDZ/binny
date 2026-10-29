declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string);
    focusOnClick: boolean;
    resizeSession: boolean;
    scaleViewport: boolean;
    viewOnly: boolean;
  }
}
