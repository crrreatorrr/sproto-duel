/** Generated from server/data/pb_shop_prices.csv. Do not edit by hand. */
export interface PbShopRow {
    shopId: string;
    itemId: string;
    packSize: number;
    price: number;
    sellPrice: number;
}
export declare const PB_SHOP: Record<string, PbShopRow>;
export declare function pbShopRow(shopId: string, itemId: string): PbShopRow | undefined;
