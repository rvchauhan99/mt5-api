import {
  buildBankResolutionCache,
  buildExchangePlayerResolutionCache,
  buildPersonResolutionCache,
  resolveBankImportKey,
  resolveExchangePlayerImportKey,
  resolvePersonImportKey,
  type BankImportMaps,
  type BankImportRecord,
  type ExchangePlayerImportMap,
} from "../src/modules/deposit/deposit-import-resolve";

describe("deposit-import-resolve", () => {
  const activeBank: BankImportRecord = {
    id: "bank-1",
    displayName: "Demo Holder - Demo Bank - 7890",
    status: "active",
  };

  const inactiveBank: BankImportRecord = {
    id: "bank-2",
    displayName: "Inactive Holder - Inactive Bank - 1234",
    status: "inactive",
  };

  describe("resolveBankImportKey", () => {
    it("resolves by account number", () => {
      const maps: BankImportMaps = {
        bankByAccountMap: new Map([["1234567890", activeBank]]),
        bankByHolderMap: new Map(),
      };
      expect(resolveBankImportKey("1234567890", maps.bankByAccountMap, maps.bankByHolderMap)).toEqual({
        status: "ok",
        id: "bank-1",
        displayName: activeBank.displayName,
      });
    });

    it("returns not_found when bank is missing", () => {
      const maps: BankImportMaps = {
        bankByAccountMap: new Map(),
        bankByHolderMap: new Map(),
      };
      expect(resolveBankImportKey("missing", maps.bankByAccountMap, maps.bankByHolderMap)).toEqual({
        status: "not_found",
      });
    });

    it("returns ambiguous when multiple banks share holder name", () => {
      const maps: BankImportMaps = {
        bankByAccountMap: new Map(),
        bankByHolderMap: new Map([["demo", "ambiguous"]]),
      };
      expect(resolveBankImportKey("demo", maps.bankByAccountMap, maps.bankByHolderMap)).toEqual({
        status: "ambiguous",
      });
    });

    it("prefers account number over ambiguous holder", () => {
      const maps: BankImportMaps = {
        bankByAccountMap: new Map([["demo", activeBank]]),
        bankByHolderMap: new Map([["demo", "ambiguous"]]),
      };
      expect(resolveBankImportKey("demo", maps.bankByAccountMap, maps.bankByHolderMap)).toEqual({
        status: "ok",
        id: "bank-1",
        displayName: activeBank.displayName,
      });
    });

    it("returns inactive when bank exists but is not active", () => {
      const maps: BankImportMaps = {
        bankByAccountMap: new Map([["inactive-acc", inactiveBank]]),
        bankByHolderMap: new Map(),
      };
      expect(resolveBankImportKey("inactive-acc", maps.bankByAccountMap, maps.bankByHolderMap)).toEqual({
        status: "inactive",
        displayName: inactiveBank.displayName,
      });
    });
  });

  describe("resolvePersonImportKey", () => {
    const personMap = new Map([
      ["john doe", { id: "person-1", name: "John Doe", isActive: true }],
      ["jane doe", { id: "person-2", name: "Jane Doe", isActive: false }],
    ]);

    it("resolves active person", () => {
      expect(resolvePersonImportKey("john doe", personMap)).toEqual({
        status: "ok",
        id: "person-1",
        name: "John Doe",
      });
    });

    it("returns not_found for unknown person", () => {
      expect(resolvePersonImportKey("unknown", personMap)).toEqual({ status: "not_found" });
    });

    it("returns inactive for inactive person", () => {
      expect(resolvePersonImportKey("jane doe", personMap)).toEqual({
        status: "inactive",
        name: "Jane Doe",
      });
    });
  });

  describe("resolveExchangePlayerImportKey", () => {
    const playerMap: ExchangePlayerImportMap = new Map([
      ["player001", { id: "mongo-1", playerIdLabel: "PLAYER001" }],
    ]);

    it("resolves exchange player id", () => {
      expect(resolveExchangePlayerImportKey("player001", playerMap)).toEqual({
        status: "ok",
        id: "mongo-1",
        playerIdLabel: "PLAYER001",
      });
    });

    it("returns not_found for unknown player id", () => {
      expect(resolveExchangePlayerImportKey("unknown", playerMap)).toEqual({ status: "not_found" });
    });

    it("returns ambiguous when multiple players share playerId", () => {
      const ambiguousMap: ExchangePlayerImportMap = new Map([["player001", "ambiguous"]]);
      expect(resolveExchangePlayerImportKey("player001", ambiguousMap)).toEqual({ status: "ambiguous" });
    });
  });

  describe("resolution caches", () => {
    it("buildBankResolutionCache resolves each unique key once", () => {
      const maps: BankImportMaps = {
        bankByAccountMap: new Map([["demo", activeBank]]),
        bankByHolderMap: new Map(),
      };
      const cache = buildBankResolutionCache(["demo", "missing"], maps);
      expect(cache.size).toBe(2);
      expect(cache.get("demo")).toEqual({ status: "ok", id: "bank-1", displayName: activeBank.displayName });
      expect(cache.get("missing")).toEqual({ status: "not_found" });
    });

    it("buildPersonResolutionCache resolves each unique name once", () => {
      const personMap = new Map([["john doe", { id: "person-1", name: "John Doe", isActive: true }]]);
      const cache = buildPersonResolutionCache(["john doe", "unknown"], personMap);
      expect(cache.get("john doe")).toEqual({ status: "ok", id: "person-1", name: "John Doe" });
      expect(cache.get("unknown")).toEqual({ status: "not_found" });
    });

    it("buildExchangePlayerResolutionCache resolves each unique player id once", () => {
      const playerMap: ExchangePlayerImportMap = new Map([
        ["player001", { id: "mongo-1", playerIdLabel: "PLAYER001" }],
      ]);
      const cache = buildExchangePlayerResolutionCache(["player001", "missing"], playerMap);
      expect(cache.get("player001")).toEqual({
        status: "ok",
        id: "mongo-1",
        playerIdLabel: "PLAYER001",
      });
      expect(cache.get("missing")).toEqual({ status: "not_found" });
    });
  });
});
