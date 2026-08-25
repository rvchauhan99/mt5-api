import xlsx from "xlsx";

/**
 * Generates an Excel buffer from the provided data and column definitions.
 * 
 * @param data Array of objects to be exported.
 * @param columns Array of column definitions: { header: string, key: string } 
 *               or { header: string, transform: (row) => any }
 * @param sheetName Name of the sheet in the Excel file.
 * @returns Buffer containing the Excel file.
 */
export function generateExcelBuffer<T = any>(
  data: T[],
  columnsOrSheetName?: { header: string; key?: string; transform?: (row: T) => any }[] | string,
  sheetName: string = "Sheet1",
): Buffer {
  const resolvedSheetName = typeof columnsOrSheetName === "string" ? columnsOrSheetName : sheetName;
  const exportData = Array.isArray(columnsOrSheetName)
    ? data.map((row) => {
        const formattedRow: Record<string, any> = {};
        for (const col of columnsOrSheetName) {
          if (col.transform) {
            formattedRow[col.header] = col.transform(row);
          } else if (col.key) {
            formattedRow[col.header] = (row as any)[col.key];
          }
        }
        return formattedRow;
      })
    : (data as Record<string, any>[]);

  const worksheet = xlsx.utils.json_to_sheet(exportData);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, resolvedSheetName);
  
  return xlsx.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/**
 * Generates a multi-sheet Excel buffer.
 * @param sheets Array of sheet definitions: { name: string, data: T[], columns: [...] }
 */
export function generateMultiSheetExcelBuffer(
  sheets: {
    name: string;
    data: any[];
    columns: { header: string; key?: string; transform?: (row: any) => any }[];
  }[]
): Buffer {
  const workbook = xlsx.utils.book_new();

  for (const sheet of sheets) {
    const exportData = sheet.data.map((row) => {
      const formattedRow: Record<string, any> = {};
      for (const col of sheet.columns) {
        if (col.transform) {
          formattedRow[col.header] = col.transform(row);
        } else if (col.key) {
          formattedRow[col.header] = (row as any)[col.key];
        }
      }
      return formattedRow;
    });

    const worksheet = xlsx.utils.json_to_sheet(exportData);
    xlsx.utils.book_append_sheet(workbook, worksheet, sheet.name);
  }

  return xlsx.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
