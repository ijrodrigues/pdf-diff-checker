import 'zone.js';

// Polyfill Promise.withResolvers for environments that don't support it (used by pdfjs-dist v5)
const _P: any = Promise as any;
if (typeof _P.withResolvers !== 'function') {
  _P.withResolvers = function <T = unknown>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: any) => void;
    const promise: Promise<T> = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

bootstrapApplication(App, appConfig)
  .catch((err: unknown) => console.error(err));
