import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findChildNamedItems,
  findLibraryChildren,
  toExcelFormula,
  toLibraryFormula,
  allChildrenOf,
} from "../src/index.ts";

const groupByAddress =
  '=LAMBDA(key_cell,length_cell,return_columns,LET(rRow, ROW(key_cell), fCol, CELL("col", return_columns), lCol, fCol + COLUMNS(return_columns) - 1, n, ROWS({ref}ExpandToLastRow(length_cell)), keyArr, {ref}ExpandToLastRow(key_cell, , n), keyArrClean, IF(keyArr = 0, "", keyArr), changedRows, {ref}NextDiff(keyArrClean), keys, CHOOSECOLS(changedRows, 1), firstRows_arr, CHOOSECOLS(changedRows, 2), lastRows_arr, VSTACK(DROP(firstRows_arr, 1) - 1, n), firstRows_sheet, firstRows_arr + rRow - 1, lastRows_sheet, lastRows_arr + rRow - 1, fCell, ADDRESS(firstRows_sheet, fCol), lCell, ADDRESS(lastRows_sheet, lCol), sheetName, "\'" & {ref}GetSheetName(key_cell) & "\'!", returnAddressArr, sheetName & fCell & ":" & lCell, HSTACK(keys, firstRows_sheet, lastRows_sheet, returnAddressArr)))';

describe("formula conversion", () => {
  it("round-trips GroupByAddress through a sheet name", () => {
    const excel = toExcelFormula(groupByAddress, "Worksheet", "Sheet1");
    assert.equal(excel.includes("{ref}"), false);
    const children = findChildNamedItems(excel, "GroupByAddress", []);
    assert.deepEqual(children, ["ExpandToLastRow", "NextDiff", "GetSheetName"]);
    const library = toLibraryFormula(excel, "Sheet1", children);
    assert.equal(library, groupByAddress);
  });

  it("quotes a sheet name that contains a space", () => {
    const excel = toExcelFormula(groupByAddress, "Worksheet", "Input Data");
    assert.match(excel, /'Input Data'!ExpandToLastRow\(/);
    const children = findChildNamedItems(excel, "GroupByAddress", []);
    assert.equal(toLibraryFormula(excel, "Input Data", children), groupByAddress);
  });

  it("drops {ref} for workbook scope and keeps an external workbook qualifier", () => {
    const library =
      "=LAMBDA(queryX,queryY,xCoords,yCoords,LET(arr, BYROW(SEQUENCE(ROWS(xCoords)), LAMBDA(i, 'Soil Spring input.xlsx'!{ref}Dist(queryX, queryY, CHOOSEROWS(xCoords, i), CHOOSEROWS(yCoords, i)))), MIN(FILTER(arr, arr > 0))))";
    const excel = toExcelFormula(library, "Workbook");
    assert.equal(excel.includes("{ref}"), false);
    assert.match(excel, /'Soil Spring input.xlsx'!Dist\(/);
    const children = findChildNamedItems(excel, "DistToNearestPoint", ["Dist"]);
    assert.deepEqual(children, ["Dist"]);
    assert.equal(toLibraryFormula(excel, "Sheet1", children), library);
  });

  it("does not treat a dotted name as a wildcard", () => {
    const formula = "=LAMBDA(x, Table.UKPFC(x) + TableXUKPFC(x))";
    const converted = toLibraryFormula(formula, "Sheet1", ["Table.UKPFC"]);
    assert.match(converted, /\{ref\}Table\.UKPFC\(/);
    assert.doesNotMatch(converted, /\{ref\}TableXUKPFC\(/);
  });

  it("reads {ref} children and ignores a call hidden in a string", () => {
    const formula = '=LAMBDA(x, "see {ref}Fake(" & {ref}Real(x))';
    assert.deepEqual(findLibraryChildren(formula, "Outer"), ["Real"]);
  });

  it("walks descendants after direct children", () => {
    const children = new Map<string, string[]>([
      ["A", ["B"]],
      ["B", ["C"]],
      ["C", []],
    ]);
    assert.deepEqual(
      allChildrenOf("A", (name) => children.get(name)),
      ["B", "C"]
    );
  });
});
