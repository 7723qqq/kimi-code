export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      error?.code === 'ERR_MODULE_NOT_FOUND' &&
      (specifier.startsWith('./') || specifier.startsWith('../'))
    ) {
      if (/\.m?js$/.test(specifier)) {
        return nextResolve(specifier.replace(/\.m?js$/, '.ts'), context);
      }
      if (!/\.[A-Za-z0-9]+$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
    }
    throw error;
  }
}
