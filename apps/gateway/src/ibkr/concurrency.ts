export async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length)
  const pending = values.entries()
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (const [index, value] of pending) {
      results[index] = await mapper(value, index)
    }
  })
  await Promise.all(workers)
  return results
}
