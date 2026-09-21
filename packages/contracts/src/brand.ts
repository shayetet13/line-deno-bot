declare const brand: unique symbol;

/** Nominal typing helper. `Brand<string, 'BotId'>` is assignable to `string`
 * but a plain `string` is not assignable to it. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };
