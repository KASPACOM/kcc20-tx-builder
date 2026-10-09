export async function withTimeout<T>(operation: Promise<T>, label: string, milliseconds = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    })]);
  } finally { clearTimeout(timer!); }
}
