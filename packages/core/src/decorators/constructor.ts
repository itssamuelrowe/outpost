/**
 * A generic class constructor type. Using `never[]` for the arguments keeps the
 * decorators usable with any constructor signature while remaining assignable
 * from concrete classes.
 */
export type Constructor<TInstance = unknown> = new (...arguments0: never[]) => TInstance;
