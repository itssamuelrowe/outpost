import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Loads the package's versioned SQL schema files from disk.
 *
 * Grouped as static members so the on-disk layout and ordering rules live with
 * their owning concern and read as `SchemaLoader.loadSchemaStatements()` at the
 * call site. Keeping the SQL in versioned files on disk, rather than embedded
 * in strings, keeps the schema reviewable and diffable.
 */
export class SchemaLoader {
    /**
     * Resolves the absolute path to the package's `schema` directory.
     *
     * The directory lives alongside the compiled output at the package root, so
     * we walk up from this module's location to find it.
     *
     * Compiled location: `<package>/dist/utilities/schema-loader.utility.js`
     * Schema location:   `<package>/schema`
     */
    private static resolveSchemaDirectory(): string {
        const currentFilePath = fileURLToPath(import.meta.url);
        return join(dirname(currentFilePath), "..", "..", "schema");
    }

    /**
     * Loads every `.sql` file from the package's schema directory in ascending
     * filename order. Each file uses `CREATE TABLE IF NOT EXISTS` and the tables
     * carry no cross-table foreign keys, so alphabetical ordering is sufficient
     * and the execution sequence does not depend on a numeric prefix.
     *
     * @returns The ordered SQL statements, one entry per file.
     */
    public static async loadSchemaStatements(): Promise<string[]> {
        const schemaDirectory = SchemaLoader.resolveSchemaDirectory();
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
}
