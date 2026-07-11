import type { ListingDetail, ListingSummary, SiteChallenge } from "./types";

export type ContentRequest =
  | {
      type: "LBC_COLLECT_SEARCH_RESULTS";
      limit: number;
    }
  | {
      type: "LBC_COLLECT_DETAIL";
    };

export type ContentResponse =
  | {
      type: "LBC_SEARCH_RESULTS";
      captcha: boolean;
      challenge?: SiteChallenge;
      listings: ListingSummary[];
    }
  | {
      type: "LBC_DETAIL";
      captcha: boolean;
      challenge?: SiteChallenge;
      detail?: ListingDetail;
    };
