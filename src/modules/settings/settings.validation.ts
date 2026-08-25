import { z } from "zod";
import { SUPPORTED_CURRENCIES } from "../../shared/constants/currencies";

export const setPlatformCurrencyBodySchema = z.object({
  currency: z.enum(SUPPORTED_CURRENCIES),
});
