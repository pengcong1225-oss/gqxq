import { copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
// Empty cache is suitable for a clean checkout. Existing operational cache is preserved.
try {
  await copyFile(new URL('../src/data/yichangPlaceGeocodes.example.json', import.meta.url),
    new URL('../src/data/yichangPlaceGeocodes.json', import.meta.url), constants.COPYFILE_EXCL);
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
