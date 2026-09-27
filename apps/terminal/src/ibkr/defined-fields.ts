/** JSON and SDK optional properties are omitted, rather than populated with undefined. */
type OptionalFields<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? { [K in keyof T]: OptionalFields<T[K]> }
    : T extends object
      ? { [K in keyof T]: OptionalFields<T[K]> | (undefined extends T[K] ? undefined : never) }
      : T

export function withoutUndefined<T>(value: OptionalFields<T>): T {
  if (Array.isArray(value)) return value.map((entry) => withoutUndefined(entry)) as T
  if (value === null || typeof value !== 'object') return value as T
  if (Object.getPrototypeOf(value) !== Object.prototype) return value as T

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      entry === undefined ? [] : [[key, withoutUndefined(entry)]],
    ),
  ) as T
}
