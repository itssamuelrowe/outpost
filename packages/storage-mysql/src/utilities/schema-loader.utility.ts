import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolves the absolute path to the package's `schema` directory.
 *
 * The directory lives alongside the compiled output at the package root, so we
 * walk up from this module's location to find it. Doing the resolution at run
 * time keeps the SQL in versioned files on disk rather than embedded in strings.
 */
function resolveSchemaDirectory(): string {
  const currentFilePath = fileURLToPath(import.meta.url);
  // Compiled location: <package>/dist/utilities/schema-loader.utility.js
  // Schema location:   <package>/schema
  return join(dirname(currentFilePath), "..", "..", "schema");
}

/**
 * Loads every `.sql` file from the package's schema directory in ascending
 * filename order, so numeric prefixes control the execution sequence.
 *
 * @returns The ordered SQL statements, one entry per file.
 */
export async function loadSchemaStatements(): Promise<string[]> {
  const schemaDirectory = resolveSchemaDirectory();
  const fileNames = (await readdir(schemaDirectory))
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  const statements: string[] = [];
  for (const fileName of fileNames) {
    const contents = await readFile(join(schemaDirectory, fileName), "utf8");
    statements.push(contents);
  }
  return statements;
}
