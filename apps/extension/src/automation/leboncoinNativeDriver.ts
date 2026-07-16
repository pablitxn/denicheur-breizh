import { detectSiteChallenge } from "../lib/leboncoinExtractors";
import { localizedTextDetail, message } from "../lib/localizedText";
import type { LocalizedText } from "../lib/types";
import type {
  FilterWarning,
  NativeSearchFilters,
  NativeSearchPhase,
  NativeSearchResponse,
  NativeResultsStep,
} from "../lib/messages";

const CATEGORY_LABELS: Record<NativeSearchFilters["category"], string[]> = {
  "9": ["Ventes immobilières", "Vente"],
  "10": ["Locations", "Location"],
  "11": ["Colocations", "Colocation"],
  "13": ["Bureaux & Commerces", "Bureaux"],
  "2001": ["Immobilier neuf", "Neuf"],
};

const CATEGORY_GROUP_LABELS: Record<NativeSearchFilters["category"], string[]> = {
  "9": ["Immobilier", "Afficher les catégories de la famille Immobilier"],
  "10": ["Immobilier", "Afficher les catégories de la famille Immobilier"],
  "11": ["Immobilier", "Afficher les catégories de la famille Immobilier"],
  "13": ["Immobilier", "Afficher les catégories de la famille Immobilier"],
  "2001": ["Immobilier", "Afficher les catégories de la famille Immobilier"],
};

const PROPERTY_TYPE_LABELS: Record<string, string> = {
  "1": "Maison",
  "2": "Appartement",
  "3": "Terrain",
  "4": "Parking",
  "5": "Autre",
};

const SELECTORS = {
  cookieRoots: [
    '[role="dialog"]',
    '[aria-modal="true"]',
    '[data-testid*="consent" i]',
    '[data-qa-id*="consent" i]',
    '[id*="cookie" i]',
    '[class*="cookie" i]',
  ],
  category: [
    'select[name*="categor" i]',
    'button[data-testid*="categor" i]',
    '[role="button"][data-testid*="categor" i]',
    '[role="combobox"][data-testid*="categor" i]',
    'button[data-qa-id*="categor" i]',
    '[role="button"][data-qa-id*="categor" i]',
    '[role="combobox"][data-qa-id*="categor" i]',
  ],
  homeSearchLauncher: [
    'input[aria-label*="rechercher sur leboncoin" i]',
    '[role="combobox"][aria-label*="rechercher sur leboncoin" i]',
    'button[aria-label*="rechercher sur leboncoin" i]',
    '[data-testid*="search" i][role="combobox"]',
    '[data-qa-id*="search" i][role="combobox"]',
  ],
  searchText: [
    'input[type="search"]:not([name*="location" i])',
    'input[name*="text" i]',
    'input[data-testid*="search" i]:not([data-testid*="location" i])',
    'input[data-qa-id*="search" i]:not([data-qa-id*="location" i])',
  ],
  location: [
    'input[name*="location" i]',
    'input[name*="place" i]',
    'input[data-testid*="location" i]',
    'input[data-qa-id*="location" i]',
  ],
  homeSubmit: [
    'button[data-testid*="search" i]',
    'button[data-qa-id*="search" i]',
    'button[type="submit"]',
  ],
  filterTrigger: [
    'button[data-testid*="filter" i]',
    'button[data-qa-id*="filter" i]',
  ],
  filterApply: [
    'button[data-testid*="apply" i]',
    'button[data-qa-id*="apply" i]',
  ],
  sort: [
    'select[name*="sort" i]',
    '[data-testid*="sort" i]',
    '[data-qa-id*="sort" i]',
  ],
  paginationRoots: [
    'nav[aria-label*="pagination" i]',
    '[role="navigation"][aria-label*="pagination" i]',
    '[data-testid*="pagination" i]',
    '[data-qa-id*="pagination" i]',
  ],
  paginationNext: [
    'a[rel~="next"]',
    'button[rel~="next"]',
    'a[data-testid*="pagination-next" i]',
    'button[data-testid*="pagination-next" i]',
    'a[data-qa-id*="pagination-next" i]',
    'button[data-qa-id*="pagination-next" i]',
  ],
} as const;

const CONTROL_SELECTOR = "button, input, select, textarea, [role='button'], [role='combobox']";
const CHOICE_SELECTOR = [
  "option",
  "label",
  '[role="option"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  '[role="treeitem"]',
  '[role="radio"]',
  '[role="checkbox"]',
  'input[type="radio"]',
  'input[type="checkbox"]',
  "button",
].join(",");

const ACTION_DELAY_MS = [350, 900] as const;
const CHARACTER_DELAY_MS = [70, 160] as const;
const WAIT_POLL_MS = 100;
const WAIT_ATTEMPTS = 50;
const RANGE_WAIT_ATTEMPTS = 150;
const CHALLENGE_GRACE_ATTEMPTS = 30;

type Sleep = (milliseconds: number) => Promise<void>;

export interface NativeDriverDependencies {
  document?: Document;
  sleep?: Sleep;
  random?: () => number;
}

export interface ArmedNativeAction {
  response: NativeSearchResponse;
  execute: () => Promise<void>;
}

export class LeboncoinNativeDriver {
  private readonly doc: Document;
  private readonly sleep: Sleep;
  private readonly random: () => number;
  private cookiesHandled = false;
  private homeSearchRoot: ParentNode;
  private homeSubmitButton: HTMLElement | undefined;
  private homeApplied: string[] = [];
  private homeOmitted: string[] = [];
  private homeSubmissionArmed = false;
  private homeSubmissionExecuted = false;
  private resultsFilterRoot: ParentNode;
  private resultsApplyButton: HTMLElement | undefined;
  private resultsSelectAction: {
    control: HTMLSelectElement;
    value: string;
    labels: string[];
  } | undefined;
  private resultsStep: NativeResultsStep = "complete";
  private resultsNavigationExpected = false;
  private resultsApplied: string[] = [];
  private resultsWarnings: FilterWarning[] = [];
  private resultsFilterChanged = false;
  private resultsPrepared = false;
  private resultsApplicationArmed = false;
  private resultsApplicationExecuted = false;
  private nextPageButton: HTMLElement | undefined;
  private paginationPrepared = false;
  private paginationAdvanceArmed = false;
  private paginationAdvanceExecuted = false;
  private queuedActionFailure: NativeSearchResponse | undefined;

  constructor(dependencies: NativeDriverDependencies = {}) {
    this.doc = dependencies.document ?? document;
    this.homeSearchRoot = this.doc;
    this.resultsFilterRoot = this.doc;
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.random = dependencies.random ?? Math.random;
  }

  async prepareHomeSearch(filters: NativeSearchFilters): Promise<NativeSearchResponse> {
    const phase = "home-prepared" as const;
    const challengeResponse = this.challengeResponse(phase);
    if (challengeResponse) return challengeResponse;

    try {
      await this.acceptCookiesOnce();
      const postCookieChallenge = this.challengeResponse(phase);
      if (postCookieChallenge) return postCookieChallenge;

      this.homeSubmitButton = undefined;
      this.homeApplied = [];
      this.homeOmitted = [];
      this.homeSubmissionArmed = false;
      this.homeSubmissionExecuted = false;
      this.queuedActionFailure = undefined;

      this.homeSearchRoot = await this.openHomeSearchSurface();
      const searchInput = this.findSearchTextInput(this.homeSearchRoot, undefined);
      const text = filters.text.trim();
      if (text) {
        if (!searchInput) {
          throw new Error("The native keyword search field was not found.");
        }
        await this.typeVisible(searchInput, text);
        this.homeApplied.push("text");
      }

      await this.applyHomeCategory(filters.category);
      await this.applyHomeLocation(filters.locationQuery);

      this.homeSearchRoot = this.findHomeSearchRoot() ?? this.homeSearchRoot;
      const liveSearchInput = this.findSearchTextInput(this.homeSearchRoot, undefined) ?? searchInput;

      this.homeSubmitButton = this.findHomeSubmit(this.homeSearchRoot, liveSearchInput, undefined);
      if (!this.homeSubmitButton) {
        throw new Error("The native search submit control was not found.");
      }

      const finalChallenge = this.challengeResponse(phase);
      if (finalChallenge) return finalChallenge;
      return this.successResponse(phase, this.homeApplied, [], undefined, undefined, this.homeOmitted);
    } catch (error) {
      const challenge = await this.challengeResponseAfterFailure(phase);
      if (challenge) return challenge;
      return this.errorResponse(phase, error, this.homeApplied, [], this.homeOmitted);
    }
  }

  armHomeSearchSubmission(): ArmedNativeAction {
    const phase = "home-submitted" as const;
    const challengeResponse = this.challengeResponse(phase);
    if (challengeResponse) return noOpAction(challengeResponse);

    if (!this.homeSubmitButton) {
      return noOpAction(
        this.errorResponse(phase, new Error("Home search must be prepared before it can be submitted."), [], []),
      );
    }
    if (this.homeSubmissionArmed || this.homeSubmissionExecuted) {
      return noOpAction(
        this.errorResponse(
          phase,
          new Error("The native home search was already submitted."),
          this.homeApplied,
          [],
          this.homeOmitted,
        ),
      );
    }

    this.homeSubmissionArmed = true;
    const response = this.successResponse(phase, this.homeApplied, [], undefined, undefined, this.homeOmitted);

    return {
      response,
      execute: async () => {
        if (this.homeSubmissionExecuted) return;
        try {
          const challenge = this.challengeResponse(phase);
          if (challenge) {
            throw new Error(
              challenge.challenge?.message
                ? localizedTextDetail(challenge.challenge.message)
                : "A site challenge interrupted submission.",
            );
          }
          const button = this.findHomeSubmit(this.homeSearchRoot, undefined, undefined);
          if (!button) throw new Error("The native search submit control is no longer available.");
          await this.clickVisible(button, () => {
            // Mark immediately before dispatching the click. If click() itself
            // throws, retrying could duplicate a submission that reached the site.
            this.homeSubmissionExecuted = true;
          });
        } catch (error) {
          if (!this.homeSubmissionExecuted) this.homeSubmissionArmed = false;
          throw error;
        }
      },
    };
  }

  async prepareResultsFilters(filters: NativeSearchFilters): Promise<NativeSearchResponse> {
    const phase = "results-prepared" as const;
    const challengeResponse = this.challengeResponse(phase);
    if (challengeResponse) return challengeResponse;

    this.resultsApplyButton = undefined;
    this.resultsSelectAction = undefined;
    this.resultsApplied = [];
    this.resultsWarnings = [];
    this.resultsFilterChanged = false;
    this.resultsStep = "complete";
    this.resultsNavigationExpected = false;
    this.resultsPrepared = false;
    this.resultsApplicationArmed = false;
    this.resultsApplicationExecuted = false;
    this.queuedActionFailure = undefined;

    try {
      await this.acceptCookiesOnce();
      const postCookieChallenge = this.challengeResponse(phase);
      if (postCookieChallenge) return postCookieChallenge;

      const locationQuery = filters.locationQuery.trim();
      if (locationQuery) {
        const locationInput = await this.resolveLocationInput(this.doc);
        if (
          (locationInput && matchesLocationValue(locationInput.value, locationQuery)) ||
          this.isObservedLocationApplied(locationQuery)
        ) {
          this.resultsApplied.push("locationQuery");
        } else {
          if (!locationInput) throw new Error("The native location field was not found on search results.");
          await this.typeVisible(locationInput, locationQuery);
          this.resultsApplyButton = await this.waitForUniqueLocationSuggestion(locationInput, locationQuery);
          this.resultsFilterRoot = this.doc;
          this.resultsStep = "location";
          this.resultsNavigationExpected = true;
          this.resultsPrepared = true;
          return this.successResponse(
            phase,
            this.resultsApplied,
            this.resultsWarnings,
            this.resultsStep,
            this.resultsNavigationExpected,
          );
        }
      }

      if (this.isCategoryApplied(filters.category)) {
        this.resultsApplied.push("category");
      } else {
        const categoryRoot = await this.openResultsFilters();
        this.resultsFilterRoot = categoryRoot;
        const categoryAction = await this.prepareCategoryChoice(categoryRoot, filters.category);
        if (categoryAction instanceof HTMLSelectElement) {
          this.resultsSelectAction = {
            control: categoryAction,
            value: filters.category,
            labels: CATEGORY_LABELS[filters.category],
          };
        } else {
          this.resultsApplyButton = categoryAction;
        }
        this.resultsStep = "category";
        this.resultsNavigationExpected = true;
        this.resultsPrepared = true;
        return this.successResponse(
          phase,
          this.resultsApplied,
          this.resultsWarnings,
          this.resultsStep,
          this.resultsNavigationExpected,
        );
      }

      if (this.arePropertyTypesApplied(filters.propertyTypes)) {
        if (filters.propertyTypes.length > 0) {
          this.resultsApplied.push("propertyTypes");
        }
      } else {
        const propertyRoot = await this.openResultsFilters();
        this.resultsFilterRoot = propertyRoot;
        const propertyApply = await this.preparePropertyTypes(propertyRoot, filters.propertyTypes);
        if (propertyApply) {
          this.resultsFilterRoot = propertyApply.root;
          this.resultsApplyButton = propertyApply.validate;
          this.resultsStep = "property-types";
          this.resultsNavigationExpected = true;
          this.resultsPrepared = true;
          return this.successResponse(
            phase,
            this.resultsApplied,
            this.resultsWarnings,
            this.resultsStep,
            this.resultsNavigationExpected,
          );
        }
      }

      const rangeStep = await this.prepareNextRangeStep(filters);
      if (rangeStep) {
        this.resultsFilterRoot = rangeStep.root;
        this.resultsApplyButton = rangeStep.button;
        this.resultsStep = rangeStep.step;
        this.resultsNavigationExpected = true;
        this.resultsPrepared = true;
        return this.successResponse(
          phase,
          this.resultsApplied,
          this.resultsWarnings,
          this.resultsStep,
          this.resultsNavigationExpected,
        );
      }

      let filterRoot = await this.openResultsFilters();
      this.resultsFilterRoot = filterRoot;
      await this.applyOwnerType(filterRoot, filters.ownerType);
      await this.applyOptionalNumber(filterRoot, "priceMin", filters.priceMin);
      await this.applyOptionalNumber(filterRoot, "priceMax", filters.priceMax);
      await this.applyOptionalNumber(filterRoot, "squareMin", filters.squareMin);
      await this.applyOptionalNumber(filterRoot, "squareMax", filters.squareMax);
      const sortHandledInPanel = await this.applySortWithinRoot(filterRoot, filters);

      filterRoot = this.findResultsFilterRoot() ?? filterRoot;
      this.resultsFilterRoot = filterRoot;
      if (this.resultsFilterChanged) {
        this.resultsApplyButton = this.findFilterApply(filterRoot);
        if (!this.resultsApplyButton) {
          throw new Error("The native results filter apply control was not found.");
        }
      } else {
        await this.closeResultsFilterPanel();
        this.resultsFilterRoot = this.doc;
        if (!sortHandledInPanel) {
          await this.prepareExternalSort(filters);
        }
      }

      const hasDeferredResultAction = Boolean(this.resultsApplyButton || this.resultsSelectAction);
      this.resultsStep = hasDeferredResultAction ? "filters" : "complete";
      this.resultsNavigationExpected = hasDeferredResultAction;
      this.resultsPrepared = this.resultsStep !== "complete";

      const finalChallenge = this.challengeResponse(phase);
      if (finalChallenge) return finalChallenge;
      return this.successResponse(
        phase,
        this.resultsApplied,
        this.resultsWarnings,
        this.resultsStep,
        this.resultsNavigationExpected,
      );
    } catch (error) {
      const challenge = await this.challengeResponseAfterFailure(phase);
      if (challenge) return challenge;
      return this.errorResponse(phase, error, this.resultsApplied, this.resultsWarnings);
    }
  }

  armResultsFilterApplication(): ArmedNativeAction {
    const phase = "results-applied" as const;
    const challengeResponse = this.challengeResponse(phase);
    if (challengeResponse) return noOpAction(challengeResponse);

    if (!this.resultsPrepared) {
      return noOpAction(
        this.errorResponse(
          phase,
          new Error("Results filters must be prepared before they can be applied."),
          [],
          [],
        ),
      );
    }

    if (this.resultsApplicationArmed || this.resultsApplicationExecuted) {
      return noOpAction(
        this.errorResponse(
          phase,
          new Error("The native results filters were already applied."),
          this.resultsApplied,
          this.resultsWarnings,
        ),
      );
    }

    this.resultsApplicationArmed = true;
    const response = this.successResponse(
      phase,
      this.resultsApplied,
      this.resultsWarnings,
      this.resultsStep,
      this.resultsNavigationExpected,
    );

    return {
      response,
      execute: async () => {
        if (this.resultsApplicationExecuted) return;
        try {
          const challenge = this.challengeResponse(phase);
          if (challenge) {
            throw new Error(
              challenge.challenge?.message
                ? localizedTextDetail(challenge.challenge.message)
                : "A site challenge interrupted filter application.",
            );
          }
          if (this.resultsSelectAction) {
            const { control, value, labels } = this.resultsSelectAction;
            const selected = await this.selectOption(control, value, labels, () => {
              this.resultsApplicationExecuted = true;
            });
            if (!selected) throw new Error(`The native category option "${labels[0]}" is no longer available.`);
            return;
          }

          const button = this.resultsApplyButton;
          if (
            button &&
            this.resultsStep === "property-types" &&
            !containsNode(this.resultsFilterRoot, button)
          ) {
            throw new Error("The captured native property type validation control left its root.");
          }
          if (!button) {
            if (this.resultsStep !== "complete") {
              throw new Error("The native results filter apply control is no longer available.");
            }
            this.resultsApplicationExecuted = true;
            return;
          }
          await this.clickVisible(button, () => {
            this.resultsApplicationExecuted = true;
          });
        } catch (error) {
          if (!this.resultsApplicationExecuted) this.resultsApplicationArmed = false;
          throw error;
        }
      },
    };
  }

  async prepareNextResultsPage(): Promise<NativeSearchResponse> {
    const phase = "pagination-prepared" as const;
    const challengeResponse = this.challengeResponse(phase);
    if (challengeResponse) return challengeResponse;

    this.nextPageButton = undefined;
    this.paginationPrepared = false;
    this.paginationAdvanceArmed = false;
    this.paginationAdvanceExecuted = false;
    this.queuedActionFailure = undefined;

    try {
      await this.acceptCookiesOnce();
      const postCookieChallenge = this.challengeResponse(phase);
      if (postCookieChallenge) return postCookieChallenge;

      this.nextPageButton = this.findNextPageControl();
      this.paginationPrepared = true;
      const finalChallenge = this.challengeResponse(phase);
      if (finalChallenge) return finalChallenge;
      return {
        ...this.successResponse(phase, [], []),
        hasNextPage: Boolean(this.nextPageButton),
      };
    } catch (error) {
      const challenge = await this.challengeResponseAfterFailure(phase);
      if (challenge) return challenge;
      return this.errorResponse(phase, error, [], []);
    }
  }

  armNextResultsPage(): ArmedNativeAction {
    const phase = "pagination-advanced" as const;
    const challengeResponse = this.challengeResponse(phase);
    if (challengeResponse) return noOpAction(challengeResponse);

    if (!this.paginationPrepared) {
      return noOpAction(
        this.errorResponse(
          phase,
          new Error("Results pagination must be prepared before advancing."),
          [],
          [],
        ),
      );
    }
    if (!this.nextPageButton) {
      return noOpAction(
        this.errorResponse(phase, new Error("The current results page has no next page."), [], []),
      );
    }
    if (this.paginationAdvanceArmed || this.paginationAdvanceExecuted) {
      return noOpAction(
        this.errorResponse(phase, new Error("The native results page was already advanced."), [], []),
      );
    }

    this.paginationAdvanceArmed = true;
    const response: NativeSearchResponse = {
      ...this.successResponse(phase, [], []),
      hasNextPage: true,
      navigationExpected: true,
    };
    const capturedButton = this.nextPageButton;

    return {
      response,
      execute: async () => {
        if (this.paginationAdvanceExecuted) return;
        try {
          const challenge = this.challengeResponse(phase);
          if (challenge) {
            throw new Error(
              challenge.challenge?.message
                ? localizedTextDetail(challenge.challenge.message)
                : "A site challenge interrupted pagination.",
            );
          }
          if (!capturedButton.isConnected || capturedButton !== this.findNextPageControl()) {
            throw new Error("The native next-page control is no longer available.");
          }
          await this.clickVisible(capturedButton, () => {
            this.paginationAdvanceExecuted = true;
          });
        } catch (error) {
          if (!this.paginationAdvanceExecuted) this.paginationAdvanceArmed = false;
          throw error;
        }
      },
    };
  }

  recordQueuedActionFailure(phase: NativeSearchPhase, error: unknown): void {
    const actionExecuted = this.wasActionExecuted(phase);
    if (!actionExecuted) this.releaseUnexecutedAction(phase);
    this.queuedActionFailure = {
      ...(this.challengeResponse(phase) ?? this.errorResponse(phase, error, [], [])),
      actionExecuted,
    };
  }

  getQueuedActionFailure(): NativeSearchResponse | undefined {
    const queued = this.queuedActionFailure;
    this.queuedActionFailure = undefined;
    if (!queued) return undefined;
    const currentChallenge = this.challengeResponse(queued.phase);
    return currentChallenge
      ? { ...currentChallenge, actionExecuted: queued.actionExecuted }
      : queued;
  }

  private wasActionExecuted(phase: NativeSearchPhase): boolean {
    if (phase === "home-submitted") return this.homeSubmissionExecuted;
    if (phase === "results-applied") return this.resultsApplicationExecuted;
    if (phase === "pagination-advanced") return this.paginationAdvanceExecuted;
    return false;
  }

  private releaseUnexecutedAction(phase: NativeSearchPhase): void {
    if (phase === "home-submitted") this.homeSubmissionArmed = false;
    if (phase === "results-applied") this.resultsApplicationArmed = false;
    if (phase === "pagination-advanced") this.paginationAdvanceArmed = false;
  }

  private findNextPageControl(): HTMLElement | undefined {
    const stableCandidates = SELECTORS.paginationNext.flatMap((selector) =>
      Array.from(this.doc.querySelectorAll<HTMLElement>(selector)),
    );
    const stable = stableCandidates.find((candidate) => isEnabledPaginationControl(candidate));
    if (stable) return stable;

    const roots = SELECTORS.paginationRoots.flatMap((selector) =>
      Array.from(this.doc.querySelectorAll<HTMLElement>(selector)),
    ).filter((root, index, all) => isVisible(root) && all.indexOf(root) === index);

    for (const root of roots) {
      const candidate = findByAccessibleName<HTMLElement>(
        root,
        "a, button, [role='button'], [role='link']",
        [/^(?:page\s+)?suivante?(?:\b|\s)/iu, /^suivante?$/iu, /^next$/iu],
        [],
      );
      if (candidate && isEnabledPaginationControl(candidate)) return candidate;
    }
    return undefined;
  }

  private async acceptCookiesOnce(): Promise<void> {
    if (this.cookiesHandled) return;

    const root = SELECTORS.cookieRoots.flatMap((selector) =>
      Array.from(this.doc.querySelectorAll<HTMLElement>(selector)),
    ).find((element) =>
      isVisible(element) &&
      /cookie|consentement|confidentialité|confidentialite|vie privée|vie privee/iu.test(visibleText(element)),
    );
    if (!root) return;

    const acceptButton = findByAccessibleName<HTMLElement>(
      root,
      "button, [role='button']",
      [/^tout accepter$/iu, /^accepter tout$/iu, /^j['’]accepte$/iu, /^accepter et continuer$/iu],
      [],
    );
    if (!acceptButton) {
      throw new Error("A visible cookie consent banner has no supported accept control.");
    }

    await this.clickVisible(acceptButton);
    const dismissed = await this.waitFor(() => !acceptButton.isConnected || !isVisible(acceptButton));
    if (!dismissed) {
      throw new Error("The cookie consent banner remained visible after accepting it once.");
    }
    this.cookiesHandled = true;
  }

  private async applyHomeCategory(category: NativeSearchFilters["category"]): Promise<void> {
    this.homeSearchRoot = this.findHomeSearchRoot() ?? this.homeSearchRoot;
    const control = this.findCategoryControl(this.homeSearchRoot, category, true);
    if (!control) {
      this.omitHome("category");
      return;
    }
    if (mayNavigateBeforeSearchSubmission(control)) {
      this.omitHome("category");
      return;
    }

    if (this.isCategoryAppliedWithin(this.homeSearchRoot, category)) {
      this.homeApplied.push("category");
      return;
    }

    const action = await this.prepareCategoryChoice(this.homeSearchRoot, category, true);
    if (action instanceof HTMLSelectElement) {
      const selected = await this.selectOption(action, category, CATEGORY_LABELS[category]);
      if (!selected) {
        throw new Error(`The native category option "${CATEGORY_LABELS[category][0]}" was not found.`);
      }
    } else {
      assertNonNavigatingAction(action, "category");
      await this.clickVisible(action);
    }

    const applied = await this.waitFor(() => this.isCategoryAppliedWithin(this.homeSearchRoot, category));
    if (!applied) {
      throw new Error(`The native home category "${CATEGORY_LABELS[category][0]}" was not selected.`);
    }
    this.homeApplied.push("category");
  }

  private async applyHomeLocation(query: string): Promise<void> {
    const locationQuery = query.trim();
    if (!locationQuery) return;

    this.homeSearchRoot = this.findHomeSearchRoot() ?? this.homeSearchRoot;
    const input = await this.resolveLocationInput(this.homeSearchRoot);
    if (!input) {
      this.omitHome("locationQuery");
      return;
    }

    if (!matchesLocationValue(input.value, locationQuery)) {
      await this.typeVisible(input, locationQuery);
      const suggestion = await this.waitForUniqueLocationSuggestion(input, locationQuery);
      const target = choiceClickTarget(suggestion);
      assertNonNavigatingAction(target, "location");
      await this.clickVisible(target);
      const selected = await this.waitFor(() =>
        matchesLocationValue(input.value, locationQuery) || isSelected(choiceStateTarget(suggestion)),
      );
      if (!selected) {
        throw new Error(`The native home location "${locationQuery}" was not selected.`);
      }
    }
    this.homeApplied.push("locationQuery");
  }

  private async openHomeSearchSurface(): Promise<ParentNode> {
    const existingRoot = this.findHomeSearchRoot();
    if (existingRoot) return existingRoot;

    const launcher = findByAccessibleName<HTMLElement>(
      this.doc,
      "input, button, [role='combobox'], [role='button']",
      [/^rechercher sur leboncoin$/iu],
      SELECTORS.homeSearchLauncher,
    );
    if (!launcher) {
      throw new Error('The native home search launcher "Rechercher sur leboncoin" was not found.');
    }

    await this.clickVisible(launcher);
    let openedRoot: ParentNode | undefined;
    await this.waitFor(() => {
      openedRoot = this.findHomeSearchRoot(launcher);
      return Boolean(openedRoot);
    });
    if (!openedRoot) {
      throw new Error("The native home search controls did not open.");
    }
    return openedRoot;
  }

  private findHomeSearchRoot(launcher?: HTMLElement): ParentNode | undefined {
    const containingComposer = launcher?.closest<HTMLElement>("form, [role='search']");
    if (
      containingComposer &&
      isVisible(containingComposer) &&
      this.isHomeSearchComposer(containingComposer)
    ) return containingComposer;

    const controlledId = launcher?.getAttribute("aria-controls");
    const controlled = controlledId ? this.doc.getElementById(controlledId) : null;
    if (controlled && isVisible(controlled) && this.isHomeSearchComposer(controlled)) return controlled;

    const dialog = Array.from(
      this.doc.querySelectorAll<HTMLElement>('[role="dialog"], dialog, [aria-modal="true"]'),
    ).find((candidate) =>
      isVisible(candidate) &&
      /recherch|cat[ée]gorie|localisation|immobilier/iu.test(visibleText(candidate)) &&
      this.isHomeSearchComposer(candidate),
    );
    if (dialog) return dialog;

    const form = Array.from(
      this.doc.querySelectorAll<HTMLElement>("form, [role='search']"),
    ).find((candidate) => isVisible(candidate) && this.isHomeSearchComposer(candidate));
    if (form) return form;

    const searchInput = this.findSearchTextInput(this.doc, undefined);
    if (!searchInput) return undefined;
    const searchRoot = searchInput.closest<HTMLElement>("form, [role='search']");
    if (searchRoot && isVisible(searchRoot) && this.isHomeSearchComposer(searchRoot)) return searchRoot;
    return this.isHomeSearchComposer(this.doc) ? this.doc : undefined;
  }

  private isHomeSearchComposer(root: ParentNode): boolean {
    const searchInput = this.findSearchTextInput(root, undefined);
    return Boolean(searchInput && this.findHomeSubmit(root, searchInput, undefined));
  }

  private async prepareCategoryChoice(
    root: ParentNode,
    category: NativeSearchFilters["category"],
    requireNonNavigating = false,
  ): Promise<HTMLElement> {
    const labels = CATEGORY_LABELS[category];
    const control = this.findCategoryControl(root, category, true);

    if (control instanceof HTMLSelectElement) {
      if (!matchingSelectOption(control, category, labels)) {
        throw new Error(`The native category option "${labels[0]}" was not found.`);
      }
      return control;
    }

    const popupRootsBeforeClick = new Set(this.visibleCategoryPopupRoots());
    if (control && requireNonNavigating) assertNonNavigatingAction(control, "category control");
    if (control) await this.clickVisible(control);
    if (!control) throw new Error(`The native category option "${labels[0]}" was not found.`);

    let option = await this.waitForUniqueCategoryChoice(
      control,
      root,
      labels,
      popupRootsBeforeClick,
    );
    if (!option) {
      const parent = await this.waitForUniqueCategoryChoice(
        control,
        root,
        CATEGORY_GROUP_LABELS[category],
        popupRootsBeforeClick,
      );
      if (parent) {
        await this.clickVisible(parent);
        option = await this.waitForUniqueCategoryChoice(
          control,
          root,
          labels,
          popupRootsBeforeClick,
        );
      }
    }
    if (!option) throw new Error(`The native category option "${labels[0]}" was not found.`);
    const target = choiceClickTarget(option);
    if (requireNonNavigating) assertNonNavigatingAction(target, "category");
    return target;
  }

  private isCategoryAppliedWithin(
    root: ParentNode,
    category: NativeSearchFilters["category"],
  ): boolean {
    const labels = CATEGORY_LABELS[category];
    const selectedChoice = Array.from(root.querySelectorAll<HTMLElement>(CHOICE_SELECTOR))
      .find((candidate) =>
        isVisible(candidate) &&
        isSelected(choiceStateTarget(candidate)) &&
        matchesNamedTarget(accessibleName(candidate), labels),
      );
    if (selectedChoice) return true;

    const control = this.findCategoryControl(root, category, true);
    if (control instanceof HTMLSelectElement) {
      return control.value === category || matchesNamedTarget(
        control.selectedOptions[0]?.textContent ?? "",
        labels,
      );
    }
    return Boolean(control && matchesNamedTarget(accessibleName(control), labels));
  }

  private isCategoryApplied(category: NativeSearchFilters["category"]): boolean {
    const currentUrl = this.doc.defaultView?.location?.href;
    if (currentUrl) {
      try {
        if (new URL(currentUrl).searchParams.get("category") === category) return true;
      } catch {
        // Fall through to the visible-control check for synthetic documents.
      }
    }

    const labels = CATEGORY_LABELS[category];
    const selectedChoice = Array.from(this.doc.querySelectorAll<HTMLElement>(CHOICE_SELECTOR))
      .find((candidate) =>
        isVisible(candidate) &&
        isSelected(choiceStateTarget(candidate)) &&
        matchesNamedTarget(accessibleName(candidate), labels),
      );
    if (selectedChoice) return true;

    const control = this.findCategoryControl(this.doc, category, true);
    if (control instanceof HTMLSelectElement) {
      return control.value === category || matchesNamedTarget(
        control.selectedOptions[0]?.textContent ?? "",
        labels,
      );
    }
    return Boolean(control && matchesNamedTarget(accessibleName(control), labels));
  }

  private findCategoryControl(
    root: ParentNode,
    category?: NativeSearchFilters["category"],
    includeGroup = true,
  ): HTMLElement | undefined {
    const labels = category ? CATEGORY_LABELS[category] : [];
    const groups = category ? CATEGORY_GROUP_LABELS[category] : [];
    const candidates = Array.from(root.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)).filter(isVisible);
    const semantic = candidates.find((candidate) => {
      if (candidate instanceof HTMLSelectElement) {
        return /cat[ée]gorie/iu.test(accessibleName(candidate)) ||
          candidate.name.toLocaleLowerCase("fr-FR").includes("categor");
      }

      const name = accessibleName(candidate);
      if (/cat[ée]gorie|toutes? les? cat[ée]gories?/iu.test(name)) return true;
      if (labels.length > 0 && matchesNamedTarget(name, labels) && hasPopupSemantics(candidate)) return true;
      return includeGroup && groups.some((group) => normalizeText(name) === normalizeText(group)) &&
        hasPopupSemantics(candidate);
    });
    if (semantic) return semantic;

    for (const selector of SELECTORS.category) {
      const fallback = Array.from(root.querySelectorAll<HTMLElement>(selector))
        .find((candidate) => isVisible(candidate) && isClickableCategoryControl(candidate));
      if (fallback) return fallback;
    }
    return undefined;
  }

  private async waitForUniqueCategoryChoice(
    control: HTMLElement,
    root: ParentNode,
    labels: string[],
    popupRootsBeforeClick: ReadonlySet<HTMLElement>,
  ): Promise<HTMLElement | undefined> {
    let choices: HTMLElement[] = [];
    let previousChoices: HTMLElement[] = [];
    let stablePasses = 0;
    let stabilized = false;
    let sawChoices = false;
    for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
      this.assertNoChallenge();
      choices = matchingNamedChoices(
        this.categoryChoiceRoots(control, root, popupRootsBeforeClick),
        labels,
        control,
      );
      sawChoices ||= choices.length > 0;
      const sameChoices = choices.length > 0 &&
        choices.length === previousChoices.length &&
        choices.every((choice, index) => choice === previousChoices[index]);
      stablePasses = sameChoices ? stablePasses + 1 : 0;
      previousChoices = choices;
      if (choices.length > 0 && stablePasses >= 2) {
        stabilized = true;
        break;
      }
      await this.sleep(WAIT_POLL_MS);
    }
    if (sawChoices && !stabilized) {
      throw new Error(`The native category option "${labels[0]}" did not stabilize.`);
    }
    if (choices.length > 1) {
      throw new Error(`The native category option "${labels[0]}" is ambiguous.`);
    }
    return choices[0];
  }

  private categoryChoiceRoots(
    control: HTMLElement,
    root: ParentNode,
    popupRootsBeforeClick: ReadonlySet<HTMLElement>,
  ): ParentNode[] {
    const roots: ParentNode[] = [];
    const controlledId = control.getAttribute("aria-controls");
    const controlled = controlledId ? this.doc.getElementById(controlledId) : null;
    if (controlled && isVisible(controlled)) return [controlled];

    roots.push(
      ...this.visibleCategoryPopupRoots().filter((candidate) => {
        const isWithinComposer = root instanceof Element ? root.contains(candidate) : true;
        return isWithinComposer || !popupRootsBeforeClick.has(candidate);
      }),
    );
    if (root instanceof HTMLElement && isVisible(root)) roots.push(root);
    return [...new Set(roots)];
  }

  private visibleCategoryPopupRoots(): HTMLElement[] {
    return Array.from(
      this.doc.querySelectorAll<HTMLElement>(
        '[role="menu"], [role="listbox"], [role="dialog"], dialog',
      ),
    ).filter(isVisible);
  }

  private findSearchTextInput(
    root: ParentNode,
    locationInput: HTMLInputElement | undefined,
  ): HTMLInputElement | undefined {
    const specific = findByAccessibleName<HTMLInputElement>(
      root,
      "input, textarea",
      [/que recherchez-vous/iu, /mot.?cl[ée]/iu, /^rechercher$/iu],
      SELECTORS.searchText,
    );
    if (specific && specific !== locationInput) return specific;

    const realSearchBox = findByAccessibleName<HTMLInputElement>(
      root,
      "input, textarea",
      [/^rechercher sur leboncoin$/iu],
      [],
    );
    if (realSearchBox && realSearchBox !== locationInput) return realSearchBox;

    return Array.from(root.querySelectorAll<HTMLInputElement>(SELECTORS.searchText.join(",")))
      .find((input) => input !== locationInput && isVisible(input));
  }

  private findLocationInput(root: ParentNode = this.doc): HTMLInputElement | undefined {
    return findByAccessibleName<HTMLInputElement>(
      root,
      "input, textarea",
      [
        /o[ùu] cherchez-vous/iu,
        /localisation/iu,
        /ville ou d[ée]partement/iu,
        /choisir une localisation/iu,
      ],
      SELECTORS.location,
    );
  }

  private isObservedLocationApplied(query: string): boolean {
    const currentUrl = this.doc.defaultView?.location?.href;
    if (!currentUrl) return false;

    try {
      const parameters = new URL(currentUrl).searchParams;
      if (!parameters.has("locations") && !parameters.has("location")) return false;
    } catch {
      return false;
    }

    const expected = normalizeText(query);
    if (!expected) return false;
    const observedCopy = normalizeText([
      this.doc.title,
      this.doc.querySelector("h1")?.textContent ?? "",
    ].join(" "));
    return observedCopy === expected ||
      observedCopy.startsWith(`${expected} `) ||
      observedCopy.includes(` ${expected} `);
  }

  private async resolveLocationInput(root: ParentNode): Promise<HTMLInputElement | undefined> {
    const direct = this.findLocationInput(root);
    if (direct) return direct;

    const trigger = findByAccessibleName<HTMLElement>(
      root,
      "button, [role='combobox'], [role='button']",
      [
        /o[ùu] cherchez-vous/iu,
        /localisation/iu,
        /ville ou d[ée]partement/iu,
        /choisir une localisation/iu,
        /toute la france/iu,
      ],
      [],
    );
    if (!trigger) return undefined;
    const visibleContainersBefore = new Set(
      Array.from(this.doc.querySelectorAll<HTMLElement>('[role="dialog"], dialog, [aria-modal="true"]'))
        .filter(isVisible),
    );
    await this.clickVisible(trigger);
    const controlledId = trigger.getAttribute("aria-controls");
    return this.waitForElement(() => {
      const scoped = this.findLocationInput(root);
      if (scoped) return scoped;
      const controlled = controlledId ? this.doc.getElementById(controlledId) : null;
      const controlledInput = controlled && isVisible(controlled)
        ? this.findLocationInput(controlled)
        : undefined;
      if (controlledInput) return controlledInput;
      const openedContainer = Array.from(
        this.doc.querySelectorAll<HTMLElement>('[role="dialog"], dialog, [aria-modal="true"]'),
      ).find((candidate) => isVisible(candidate) && !visibleContainersBefore.has(candidate));
      return openedContainer ? this.findLocationInput(openedContainer) : undefined;
    });
  }

  private async waitForUniqueLocationSuggestion(
    input: HTMLInputElement,
    query: string,
  ): Promise<HTMLElement> {
    const normalizedQuery = normalizeText(query);
    let matches: HTMLElement[] = [];
    let previousMatches: HTMLElement[] = [];
    let stablePasses = 0;
    let stabilized = false;
    let sawMatches = false;

    for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
      this.assertNoChallenge();
      const candidates = this.locationSuggestions(input).filter((option) => {
        const candidate = normalizeText(accessibleName(option) || visibleText(option));
        return candidate === normalizedQuery || candidate.startsWith(`${normalizedQuery} `);
      });
      const exact = candidates.filter((option) =>
        normalizeText(accessibleName(option) || visibleText(option)) === normalizedQuery,
      );
      matches = exact.length === 1 ? exact : candidates;
      sawMatches ||= matches.length > 0;
      const sameMatches = matches.length > 0 &&
        matches.length === previousMatches.length &&
        matches.every((option, index) => option === previousMatches[index]);
      stablePasses = sameMatches ? stablePasses + 1 : 0;
      previousMatches = matches;
      if (matches.length > 0 && stablePasses >= 2) {
        stabilized = true;
        break;
      }
      await this.sleep(WAIT_POLL_MS);
    }

    if (sawMatches && !stabilized) {
      throw new Error(`The native location suggestion for "${query}" did not stabilize.`);
    }

    if (matches.length === 0) {
      throw new Error(`No native location suggestion matched "${query}".`);
    }

    if (matches.length !== 1) {
      throw new Error(`Location "${query}" is ambiguous; choose a more precise city or department.`);
    }

    return matches[0];
  }

  private locationSuggestions(input: HTMLInputElement): HTMLElement[] {
    const controlledId = input.getAttribute("aria-controls");
    const controlled = controlledId ? this.doc.getElementById(controlledId) : null;
    const roots = controlled
      ? [controlled]
      : Array.from(this.doc.querySelectorAll<HTMLElement>('[role="listbox"], [data-testid*="suggest" i], [data-qa-id*="suggest" i]'));

    return roots.flatMap((root) => {
      const roleOptions = Array.from(root.querySelectorAll<HTMLElement>('[role="option"]')).filter(isVisible);
      if (roleOptions.length > 0) return roleOptions;
      const listItems = Array.from(root.querySelectorAll<HTMLElement>("li")).filter(isVisible);
      if (listItems.length > 0) return listItems;
      return Array.from(root.querySelectorAll<HTMLElement>("button")).filter(isVisible);
    });
  }

  private findHomeSubmit(
    root: ParentNode,
    searchInput: HTMLInputElement | undefined,
    locationInput: HTMLInputElement | undefined,
  ): HTMLElement | undefined {
    const form = searchInput?.closest("form") ?? locationInput?.closest("form") ?? root;
    const patterns = [
      /^valider votre recherche$/iu,
      /^rechercher$/iu,
      /lancer la recherche/iu,
      /voir les annonces/iu,
    ];
    const scoped = findByAccessibleName<HTMLElement>(
      form,
      "button, input[type='submit'], [role='button']",
      patterns,
      SELECTORS.homeSubmit,
    );
    return scoped;
  }

  private async openResultsFilters(): Promise<ParentNode> {
    const existing = this.findResultsFilterRoot();
    if (existing) return existing;

    const trigger = findByAccessibleName<HTMLElement>(
      this.doc,
      "button, [role='button']",
      [/^filtres?$/iu, /tous les filtres/iu, /modifier les filtres/iu],
      SELECTORS.filterTrigger,
    );
    if (trigger) await this.clickVisible(trigger);

    const dialog = await this.waitForElement(() => this.findResultsFilterRoot());
    if (trigger && !dialog) {
      throw new Error("The native results filter panel did not open.");
    }
    return dialog ?? this.doc;
  }

  private findResultsFilterRoot(): HTMLElement | undefined {
    const semanticDialogs = Array.from(
      this.doc.querySelectorAll<HTMLElement>('[role="dialog"], dialog, [aria-modal="true"]'),
    ).filter((element) => isVisible(element));
    const isStructuredFilterRoot = (element: HTMLElement) => {
      const close = findByAccessibleName<HTMLElement>(
        element,
        "button, [role='button']",
        [/^fermer$/iu],
        [],
      );
      const filterControl = findByAccessibleName<HTMLElement>(
        element,
        CONTROL_SELECTOR,
        [/ouvrir le filtre cat[ée]gories/iu, /ouvrir le filtre type de bien/iu, /^rechercher$/iu],
        [],
      );
      return Boolean(close && filterControl);
    };
    const semanticDialog = semanticDialogs.find((element) =>
      /\btous les filtres\b/iu.test(`${accessibleName(element)} ${visibleText(element)}`) &&
      isStructuredFilterRoot(element),
    ) ?? semanticDialogs.find((element) =>
      /filtrer|cat[ée]gories|prix|surface|pi[èe]ces?/iu.test(visibleText(element)) &&
      isStructuredFilterRoot(element),
    );
    if (semanticDialog) return semanticDialog;

    const heading = findByAccessibleName<HTMLElement>(
      this.doc,
      "h1, h2, h3, h4, h5, h6, [role='heading']",
      [/^tous les filtres$/iu],
      [],
    );
    if (!heading) return undefined;

    for (let current = heading.parentElement; current; current = current.parentElement) {
      if (!isVisible(current)) continue;
      const close = findByAccessibleName<HTMLElement>(
        current,
        "button, [role='button']",
        [/^fermer$/iu],
        [],
      );
      const filterControl = findByAccessibleName<HTMLElement>(
        current,
        CONTROL_SELECTOR,
        [/ouvrir le filtre cat[ée]gories/iu, /ouvrir le filtre type de bien/iu, /^rechercher$/iu],
        [],
      );
      if (close && filterControl) return current;
    }
    return undefined;
  }

  private async preparePropertyTypes(
    root: ParentNode,
    propertyTypes: string[],
  ): Promise<{ root: ParentNode; validate: HTMLElement } | undefined> {
    let choiceRoot: ParentNode = root;
    const knownPropertyTypes = Object.entries(PROPERTY_TYPE_LABELS);
    const knownLabels = knownPropertyTypes.map(([, label]) => label);
    const requested = new Set(propertyTypes);
    const observed = new Set(this.observedPropertyTypes() ?? []);
    const hasVisibleChoice = knownLabels.some((label) =>
      Boolean(findByAccessibleName<HTMLElement>(choiceRoot, CHOICE_SELECTOR, [exactTextPattern(label)], [])),
    );
    if (!hasVisibleChoice) {
      const trigger = findByAccessibleName<HTMLElement>(
        root,
        "button, [role='button'], [role='combobox']",
        [/type de bien/iu],
        [],
      );
      if (trigger) {
        await this.clickVisible(trigger);
        const openedChoice = await this.waitForElement(() =>
          knownLabels
            .map((label) => findByAccessibleName<HTMLElement>(this.doc, CHOICE_SELECTOR, [exactTextPattern(label)], []))
            .find((choice): choice is HTMLElement => Boolean(choice)),
        );
        if (openedChoice) {
          choiceRoot = findChoicePanel(openedChoice, root);
        }
      }
    }

    const missing: string[] = [];
    for (const propertyType of requested) {
      if (!PROPERTY_TYPE_LABELS[propertyType]) missing.push(propertyType);
    }
    for (const propertyType of observed) {
      if (!requested.has(propertyType) && !PROPERTY_TYPE_LABELS[propertyType]) missing.push(propertyType);
    }

    let staged = false;
    for (const [propertyType, label] of knownPropertyTypes) {
      const choice = findByAccessibleName<HTMLElement>(choiceRoot, CHOICE_SELECTOR, [exactTextPattern(label)], []);
      if (!choice) {
        if (requested.has(propertyType) || observed.has(propertyType)) missing.push(label);
        continue;
      }
      const shouldBeSelected = requested.has(propertyType);
      if (isSelected(choiceStateTarget(choice)) !== shouldBeSelected) {
        await this.clickVisible(choiceClickTarget(choice));
        staged = true;
      }
    }

    let validate: HTMLElement | undefined;
    if (staged) {
      validate = findByAccessibleName<HTMLElement>(
        choiceRoot,
        "button, [role='button']",
        [/^valider$/iu],
        [],
      );
      if (!validate) {
        throw new Error("The native property type validation control was not found.");
      }
    }

    if (missing.length > 0) {
      this.warn("propertyTypes", message("warning.propertyTypesUnavailable", { types: missing.join(", ") }));
    }
    return validate ? { root: choiceRoot, validate } : undefined;
  }

  private arePropertyTypesApplied(propertyTypes: string[]): boolean {
    const observed = this.observedPropertyTypes();
    if (!observed) return false;

    const expected = new Set(propertyTypes);
    const selected = new Set(observed);
    return expected.size === selected.size && [...expected].every((propertyType) => selected.has(propertyType));
  }

  private observedPropertyTypes(): string[] | undefined {
    const currentUrl = this.doc.defaultView?.location?.href;
    if (currentUrl) {
      try {
        return new URL(currentUrl).searchParams
          .getAll("real_estate_type")
          .flatMap((value) => value.split(/[,|\s]+/u))
          .filter(Boolean);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private async applyOwnerType(root: ParentNode, ownerType: NativeSearchFilters["ownerType"]): Promise<void> {
    if (ownerType === "all") return;
    root = this.findResultsFilterRoot() ?? root;
    const label = ownerType === "private" ? "Particulier" : "Professionnel";
    const choice = findByAccessibleName<HTMLElement>(root, CHOICE_SELECTOR, [exactTextPattern(label), new RegExp(`^${label}`, "iu")], []);
    if (!choice) {
      this.warn("ownerType", message("warning.sellerControlMissing", { label }));
      return;
    }

    const target = choiceClickTarget(choice);
    if (!isSelected(choiceStateTarget(choice))) {
      await this.clickVisible(target);
      this.resultsFilterChanged = true;
    }
    this.resultsApplied.push("ownerType");
  }

  private async prepareNextRangeStep(
    filters: NativeSearchFilters,
  ): Promise<{
    root: ParentNode;
    button: HTMLElement;
    step: Extract<NativeResultsStep, "rooms-min" | "rooms-max" | "bedrooms-min" | "bedrooms-max">;
  } | undefined> {
    const groups = [
      {
        parameter: "rooms" as const,
        minField: "roomsMin" as const,
        maxField: "roomsMax" as const,
        minStep: "rooms-min" as const,
        maxStep: "rooms-max" as const,
        min: filters.roomsMin,
        max: filters.roomsMax,
      },
      {
        parameter: "bedrooms" as const,
        minField: "bedroomsMin" as const,
        maxField: "bedroomsMax" as const,
        minStep: "bedrooms-min" as const,
        maxStep: "bedrooms-max" as const,
        min: filters.bedroomsMin,
        max: filters.bedroomsMax,
      },
    ];

    for (const group of groups) {
      if (group.min === undefined && group.max === undefined) continue;
      const expectedMin = Math.max(1, Math.min(8, Math.trunc(group.min ?? 1)));
      const expectedMax = Math.max(expectedMin, Math.min(8, Math.trunc(group.max ?? 8)));
      const observed = this.observedRange(group.parameter);

      if (observed?.minimum === expectedMin) {
        if (group.min !== undefined) this.resultsApplied.push(group.minField);
      } else {
        const choice = observed && observed.minimum < expectedMin
          ? { value: observed.minimum, mode: "deselect" as const }
          : { value: expectedMin, mode: "select" as const };
        const staged = await this.prepareRangeChoice(group.minField, choice.value, choice.mode);
        if (staged) return { ...staged, step: group.minStep };
        this.warn(group.minField, message("warning.nativeControlMissing", {
          control: NUMERIC_FILTERS[group.minField].description,
        }));
        continue;
      }

      if (observed?.maximum === expectedMax) {
        if (group.max !== undefined) this.resultsApplied.push(group.maxField);
      } else {
        const choice = observed && observed.maximum > expectedMax
          ? { value: observed.maximum, mode: "deselect" as const }
          : { value: expectedMax, mode: "select" as const };
        const staged = await this.prepareRangeChoice(group.maxField, choice.value, choice.mode);
        if (staged) return { ...staged, step: group.maxStep };
        this.warn(group.maxField, message("warning.nativeControlMissing", {
          control: NUMERIC_FILTERS[group.maxField].description,
        }));
      }
    }
    return undefined;
  }

  private observedRange(parameter: "rooms" | "bedrooms"): {
    minimum: number;
    maximum: number;
  } | undefined {
    const currentUrl = this.doc.defaultView?.location?.href;
    if (!currentUrl) return undefined;
    try {
      const raw = new URL(currentUrl).searchParams.get(parameter);
      const match = raw?.match(/^(\d+)(?:-(\d+))?$/u);
      if (!match) return undefined;
      return {
        minimum: Number(match[1]),
        maximum: Number(match[2] ?? match[1]),
      };
    } catch {
      return undefined;
    }
  }

  private async prepareRangeChoice(
    field: Extract<NumericFilterField, "roomsMin" | "roomsMax" | "bedroomsMin" | "bedroomsMax">,
    value: number,
    mode: "select" | "deselect",
  ): Promise<{ root: ParentNode; button: HTMLElement } | undefined> {
    const root = await this.openResultsFilters();
    const sectionPattern = field === "roomsMin" || field === "roomsMax"
      ? /^(?:nombre de )?pi[èe]ces?$/iu
      : /^(?:nombre de )?chambres?$/iu;
    const findTarget = () => {
      const liveRoot = this.findResultsFilterRoot() ?? root;
      return findRangeChoiceTarget(liveRoot, sectionPattern, value, mode)
        ?? (liveRoot === this.doc
          ? undefined
          : findRangeChoiceTarget(this.doc, sectionPattern, value, mode));
    };
    let target = findTarget();
    if (target) return target;

    const liveRoot = this.findResultsFilterRoot() ?? root;
    const trigger = findRangeFilterTrigger(liveRoot, sectionPattern)
      ?? (liveRoot === this.doc ? undefined : findRangeFilterTrigger(this.doc, sectionPattern));
    if (trigger) await this.clickVisible(trigger);

    await this.waitFor(() => {
      target = findTarget();
      return Boolean(target);
    }, RANGE_WAIT_ATTEMPTS);
    return target;
  }

  private async applyOptionalNumber(
    root: ParentNode,
    field: NumericFilterField,
    value: number | undefined,
  ): Promise<void> {
    if (value === undefined) return;
    root = this.findResultsFilterRoot() ?? root;
    const rangeButtonApplied = await this.applyRangeButton(root, field, value);
    if (rangeButtonApplied) return;

    const definition = NUMERIC_FILTERS[field];
    const input = findByAccessibleName<HTMLInputElement>(
      root,
      "input",
      definition.names,
      definition.selectors,
    );
    if (!input) {
      this.warn(field, message("warning.nativeControlMissing", { control: definition.description }));
      return;
    }

    if (numericInputMatches(input.value, value)) {
      this.resultsApplied.push(field);
      return;
    }

    await this.typeVisible(input, String(Math.trunc(value)));
    this.resultsFilterChanged = true;
    this.resultsApplied.push(field);
  }

  private async applyRangeButton(
    root: ParentNode,
    field: NumericFilterField,
    value: number,
  ): Promise<boolean> {
    const sectionPattern = field === "roomsMin" || field === "roomsMax"
      ? /^(?:nombre de )?pi[èe]ces?$/iu
      : field === "bedroomsMin" || field === "bedroomsMax"
        ? /^(?:nombre de )?chambres?$/iu
        : undefined;
    if (!sectionPattern) return false;

    const currentRoot = this.findResultsFilterRoot() ?? root;
    const section = findRangeSection(currentRoot, sectionPattern);
    if (!section) return false;
    const selectedButton = findRangeChoiceButton(section, value, "deselect");
    if (selectedButton) {
      this.resultsApplied.push(field);
      return true;
    }
    const button = findRangeChoiceButton(section, value, "select");
    if (!button) return false;

    if (!isSelected(button)) await this.clickVisible(button);
    this.resultsFilterChanged = true;
    this.resultsApplied.push(field);
    return true;
  }

  private async applySortWithinRoot(
    root: ParentNode,
    filters: NativeSearchFilters,
  ): Promise<boolean> {
    const labels = sortLabels(filters);
    const directChoice = findByAccessibleName<HTMLElement>(
      root,
      CHOICE_SELECTOR,
      labels.map(exactTextPattern),
      [],
    );
    if (directChoice && !(directChoice instanceof HTMLOptionElement)) {
      const target = choiceClickTarget(directChoice);
      if (!isSelected(choiceStateTarget(directChoice))) {
        await this.clickVisible(target);
        this.resultsFilterChanged = true;
      }
      this.resultsApplied.push("sort");
      return true;
    }

    const control = findByAccessibleName<HTMLElement>(
      root,
      CONTROL_SELECTOR,
      [/^tri$/iu, /trier/iu, /classer/iu],
      SELECTORS.sort,
    );
    if (!control) return false;

    if (control instanceof HTMLSelectElement) {
      const option = matchingSelectOption(control, `${filters.sort}-${filters.order}`, labels);
      if (!option) {
        this.warn("sort", message("warning.sortOptionMissing", { label: labels[0] ?? "" }));
        return true;
      }
      if (control.value === option.value) {
        this.resultsApplied.push("sort");
        return true;
      }
      const previousValue = control.value;
      const selected = await this.selectOption(control, `${filters.sort}-${filters.order}`, labels);
      if (!selected) {
        this.warn("sort", message("warning.sortOptionMissing", { label: labels[0] ?? "" }));
        return true;
      }
      if (control.value !== previousValue) this.resultsFilterChanged = true;
      this.resultsApplied.push("sort");
      return true;
    }

    await this.clickVisible(control);
    const option = await this.waitForElement(() =>
      findByAccessibleName<HTMLElement>(
        this.doc,
        CHOICE_SELECTOR,
        labels.map(exactTextPattern),
        [],
      ),
    );
    if (!option) {
      this.warn("sort", message("warning.sortOptionMissing", { label: labels[0] ?? "" }));
      return true;
    }
    await this.clickVisible(choiceClickTarget(option));
    this.resultsFilterChanged = true;
    this.resultsApplied.push("sort");
    return true;
  }

  private async prepareExternalSort(filters: NativeSearchFilters): Promise<void> {
    const labels = sortLabels(filters);
    const directChoice = findByAccessibleName<HTMLElement>(
      this.doc,
      CHOICE_SELECTOR,
      labels.map(exactTextPattern),
      [],
    );
    if (directChoice && !(directChoice instanceof HTMLOptionElement)) {
      if (isSelected(choiceStateTarget(directChoice))) {
        this.resultsApplied.push("sort");
      } else {
        this.resultsApplyButton = choiceClickTarget(directChoice);
      }
      return;
    }

    const control = findByAccessibleName<HTMLElement>(
      this.doc,
      CONTROL_SELECTOR,
      [/^tri$/iu, /trier/iu, /classer/iu],
      SELECTORS.sort,
    );
    if (!control) {
      this.warn("sort", message("warning.sortControlMissing"));
      return;
    }

    if (control instanceof HTMLSelectElement) {
      const option = matchingSelectOption(control, `${filters.sort}-${filters.order}`, labels);
      if (!option) {
        this.warn("sort", message("warning.sortOptionMissing", { label: labels[0] ?? "" }));
      } else if (control.value === option.value) {
        this.resultsApplied.push("sort");
      } else {
        this.resultsSelectAction = {
          control,
          value: `${filters.sort}-${filters.order}`,
          labels,
        };
      }
      return;
    }

    await this.clickVisible(control);
    const controlledId = control.getAttribute("aria-controls");
    const option = await this.waitForElement(() => {
      const controlled = controlledId ? this.doc.getElementById(controlledId) : null;
      return findByAccessibleName<HTMLElement>(
        controlled && isVisible(controlled) ? controlled : this.doc,
        CHOICE_SELECTOR,
        labels.map(exactTextPattern),
        [],
      );
    });
    if (!option) {
      this.warn("sort", message("warning.sortOptionMissing", { label: labels[0] ?? "" }));
      return;
    }
    this.resultsApplyButton = choiceClickTarget(option);
  }

  private findFilterApply(root: ParentNode): HTMLElement | undefined {
    return findByAccessibleName<HTMLElement>(
      root,
      "button, input[type='submit'], [role='button']",
      [
        /afficher.*r[ée]sultat/iu,
        /^appliquer$/iu,
        /^rechercher$/iu,
        /^valider$/iu,
        /voir.*annonce/iu,
      ],
      SELECTORS.filterApply,
    );
  }

  private async closeResultsFilterPanel(): Promise<void> {
    const root = this.findResultsFilterRoot();
    if (!root) return;

    const close = findByAccessibleName<HTMLElement>(
      root,
      "button, [role='button']",
      [/^fermer$/iu],
      [],
    );
    if (!close) {
      throw new Error("The native results filter close control was not found.");
    }

    await this.clickVisible(close);
    const closed = await this.waitFor(() => !root.isConnected || !isVisible(root));
    if (!closed) {
      throw new Error("The native results filter panel remained visible after verification.");
    }
  }

  private async selectOption(
    select: HTMLSelectElement,
    value: string,
    labels: string[],
    beforeChange?: () => void,
  ): Promise<boolean> {
    const option = matchingSelectOption(select, value, labels);
    if (!option) return false;

    if (select.value !== option.value) {
      this.assertNoChallenge();
      await this.actionDelay();
      this.assertNoChallenge();
      assertVisible(select);
      select.focus({ preventScroll: true });
      beforeChange?.();
      select.value = option.value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return true;
  }

  private async typeVisible(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
    this.assertNoChallenge();
    assertVisible(input);
    await this.actionDelay();
    this.assertNoChallenge();
    assertVisible(input);
    input.scrollIntoView?.({ block: "center", inline: "nearest" });
    input.focus({ preventScroll: true });
    setNativeInputValue(input, "");
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));

    let typed = "";
    for (const character of value) {
      this.assertNoChallenge();
      typed += character;
      setNativeInputValue(input, typed);
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: character,
        inputType: "insertText",
      }));
      await this.sleep(this.randomBetween(...CHARACTER_DELAY_MS));
      this.assertNoChallenge();
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  private async clickVisible(element: HTMLElement, beforeClick?: () => void): Promise<void> {
    this.assertNoChallenge();
    assertVisible(element);
    await this.actionDelay();
    this.assertNoChallenge();
    assertVisible(element);
    element.scrollIntoView?.({ block: "center", inline: "nearest" });
    element.focus({ preventScroll: true });
    beforeClick?.();
    element.click();
  }

  private async actionDelay(): Promise<void> {
    await this.sleep(this.randomBetween(...ACTION_DELAY_MS));
  }

  private randomBetween(minimum: number, maximum: number): number {
    const random = Math.max(0, Math.min(1, this.random()));
    return Math.round(minimum + (maximum - minimum) * random);
  }

  private async waitFor(predicate: () => boolean, attempts = WAIT_ATTEMPTS): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      this.assertNoChallenge();
      if (predicate()) return true;
      await this.sleep(WAIT_POLL_MS);
    }
    this.assertNoChallenge();
    return predicate();
  }

  private async waitForElement<T extends Element>(find: () => T | undefined): Promise<T | undefined> {
    let element = find();
    if (element) return element;
    await this.waitFor(() => {
      element = find();
      return Boolean(element);
    });
    return element;
  }

  private challengeResponse(phase: NativeSearchPhase): NativeSearchResponse | undefined {
    const challenge = detectSiteChallenge(this.doc);
    if (!challenge) return undefined;
    return {
      type: "LBC_NATIVE_SEARCH_RESULT",
      phase,
      ok: false,
      applied: [],
      omitted: [],
      warnings: [],
      challenge,
    };
  }

  private async challengeResponseAfterFailure(
    phase: NativeSearchPhase,
  ): Promise<NativeSearchResponse | undefined> {
    let response = this.challengeResponse(phase);
    if (response) return response;

    for (let attempt = 0; attempt < CHALLENGE_GRACE_ATTEMPTS; attempt += 1) {
      await this.sleep(WAIT_POLL_MS);
      response = this.challengeResponse(phase);
      if (response) return response;
    }
    return undefined;
  }

  private assertNoChallenge(): void {
    const challenge = detectSiteChallenge(this.doc);
    if (challenge) throw new Error(localizedTextDetail(challenge.message));
  }

  private successResponse(
    phase: NativeSearchPhase,
    applied: string[],
    warnings: FilterWarning[],
    step?: NativeResultsStep,
    navigationExpected?: boolean,
    omitted: string[] = warnings.map((warning) => warning.field),
  ): NativeSearchResponse {
    return {
      type: "LBC_NATIVE_SEARCH_RESULT",
      phase,
      ok: true,
      applied: [...new Set(applied)],
      omitted: [...new Set(omitted)],
      warnings: [...warnings],
      ...(step ? { step } : {}),
      ...(navigationExpected !== undefined ? { navigationExpected } : {}),
    };
  }

  private errorResponse(
    phase: NativeSearchPhase,
    error: unknown,
    applied: string[],
    warnings: FilterWarning[],
    omitted: string[] = warnings.map((warning) => warning.field),
  ): NativeSearchResponse {
    return {
      type: "LBC_NATIVE_SEARCH_RESULT",
      phase,
      ok: false,
      applied: [...new Set(applied)],
      omitted: [...new Set(omitted)],
      warnings: [...warnings],
      error: error instanceof Error
        ? message("error.nativeInteraction", undefined, error.message)
        : message("error.nativeInteraction"),
    };
  }

  private warn(field: string, warningMessage: LocalizedText): void {
    const diagnostic = localizedTextDetail(warningMessage);
    if (!this.resultsWarnings.some(
      (warning) => warning.field === field && localizedTextDetail(warning.message) === diagnostic,
    )) {
      this.resultsWarnings.push({ field, message: warningMessage });
    }
  }

  private omitHome(field: string): void {
    if (!this.homeOmitted.includes(field)) this.homeOmitted.push(field);
  }
}

type NumericFilterField = keyof typeof NUMERIC_FILTERS;

const NUMERIC_FILTERS = {
  priceMin: {
    description: "minimum price",
    names: [/prix minimum/iu, /prix min\.?/iu, /minimum.*prix/iu],
    selectors: ['input[name*="price" i][name*="min" i]', 'input[data-testid*="price_min" i]', 'input[data-qa-id*="price_min" i]'],
  },
  priceMax: {
    description: "maximum price",
    names: [/prix maximum/iu, /prix max\.?/iu, /maximum.*prix/iu],
    selectors: ['input[name*="price" i][name*="max" i]', 'input[data-testid*="price_max" i]', 'input[data-qa-id*="price_max" i]'],
  },
  roomsMin: {
    description: "minimum rooms",
    names: [/pi[èe]ces minimum/iu, /pi[èe]ces min\.?/iu, /minimum.*pi[èe]ces/iu],
    selectors: ['input[name*="room" i][name*="min" i]', 'input[data-testid*="rooms_min" i]', 'input[data-qa-id*="rooms_min" i]'],
  },
  roomsMax: {
    description: "maximum rooms",
    names: [/pi[èe]ces maximum/iu, /pi[èe]ces max\.?/iu, /maximum.*pi[èe]ces/iu],
    selectors: ['input[name*="room" i][name*="max" i]', 'input[data-testid*="rooms_max" i]', 'input[data-qa-id*="rooms_max" i]'],
  },
  bedroomsMin: {
    description: "minimum bedrooms",
    names: [/chambres minimum/iu, /chambres min\.?/iu, /minimum.*chambres/iu],
    selectors: ['input[name*="bedroom" i][name*="min" i]', 'input[data-testid*="bedrooms_min" i]', 'input[data-qa-id*="bedrooms_min" i]'],
  },
  bedroomsMax: {
    description: "maximum bedrooms",
    names: [/chambres maximum/iu, /chambres max\.?/iu, /maximum.*chambres/iu],
    selectors: ['input[name*="bedroom" i][name*="max" i]', 'input[data-testid*="bedrooms_max" i]', 'input[data-qa-id*="bedrooms_max" i]'],
  },
  squareMin: {
    description: "minimum surface",
    names: [/surface minimum/iu, /surface min\.?/iu, /minimum.*surface/iu],
    selectors: ['input[name*="square" i][name*="min" i]', 'input[name*="surface" i][name*="min" i]', 'input[data-testid*="square_min" i]'],
  },
  squareMax: {
    description: "maximum surface",
    names: [/surface maximum/iu, /surface max\.?/iu, /maximum.*surface/iu],
    selectors: ['input[name*="square" i][name*="max" i]', 'input[name*="surface" i][name*="max" i]', 'input[data-testid*="square_max" i]'],
  },
} as const;

function sortLabels(filters: NativeSearchFilters): string[] {
  if (filters.sort === "relevance") return ["Pertinence"];
  return filters.order === "asc"
    ? ["Plus anciennes", "Date : plus anciennes"]
    : ["Plus récentes", "Date : plus récentes"];
}

function matchingSelectOption(
  select: HTMLSelectElement,
  value: string,
  labels: string[],
): HTMLOptionElement | undefined {
  const normalizedLabels = labels.map(normalizeText);
  return Array.from(select.options).find((candidate) => {
    const label = normalizeText(candidate.textContent ?? candidate.label);
    return candidate.value === value || normalizedLabels.some(
      (expected) => label === expected || label.startsWith(`${expected} `),
    );
  });
}

function matchesNamedTarget(value: string, labels: string[]): boolean {
  const normalized = normalizeText(value);
  return labels.some((label) => {
    const expected = normalizeText(label);
    return normalized === expected || normalized.startsWith(`${expected} `);
  });
}

function matchingNamedChoices(
  roots: ParentNode[],
  labels: string[],
  excluded: HTMLElement,
): HTMLElement[] {
  const normalizedLabels = labels.map(normalizeText);
  const candidates = roots.flatMap((root) =>
    Array.from(root.querySelectorAll<HTMLElement>(CHOICE_SELECTOR)),
  ).filter((candidate) => candidate !== excluded && isVisible(candidate));

  const uniqueTargets = (matches: HTMLElement[]) => [
    ...new Set(matches.map(choiceClickTarget)),
  ];
  const exact = uniqueTargets(candidates.filter((candidate) =>
    normalizedLabels.includes(normalizeText(accessibleName(candidate) || visibleText(candidate))),
  ));
  if (exact.length > 0) return exact;

  return uniqueTargets(candidates.filter((candidate) => {
    const name = normalizeText(accessibleName(candidate) || visibleText(candidate));
    return normalizedLabels.some((expected) => name.startsWith(`${expected} `));
  }));
}

function hasPopupSemantics(element: HTMLElement): boolean {
  if (element instanceof HTMLSelectElement) return true;
  return element.hasAttribute("aria-haspopup") ||
    element.hasAttribute("aria-controls") ||
    element.hasAttribute("aria-expanded");
}

function isClickableCategoryControl(element: HTMLElement): boolean {
  return element instanceof HTMLSelectElement ||
    element instanceof HTMLButtonElement ||
    element.getAttribute("role") === "button" ||
    element.getAttribute("role") === "combobox";
}

function containsNode(root: ParentNode, element: Element): boolean {
  return root instanceof Node && root.contains(element);
}

function findChoicePanel(choice: HTMLElement, fallback: ParentNode): ParentNode {
  for (let current = choice.parentElement; current; current = current.parentElement) {
    const validate = findByAccessibleName<HTMLElement>(
      current,
      "button, [role='button']",
      [/^valider$/iu],
      [],
    );
    if (validate) return current;
    if (current === fallback) break;
  }
  return fallback;
}

function findRangeSection(root: ParentNode, headingPattern: RegExp): HTMLElement | undefined {
  const headings = rankByRenderedPresence(
    Array.from(
      root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6, legend, [role='heading']"),
    ).filter((candidate) => isVisible(candidate) && headingPattern.test(accessibleName(candidate))),
  );

  for (const heading of headings) {
    for (let current = heading.parentElement; current; current = current.parentElement) {
      const rangeButton = Array.from(
        current.querySelectorAll<HTMLElement>("button, [role='button']"),
      ).find((candidate) => isVisible(candidate) && (
        rangeChoiceValue(candidate) !== undefined || isRangeChoiceAction(candidate)
      ));
      if (rangeButton) {
        const rangeHeadings = Array.from(
          current.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6, legend, [role='heading']"),
        ).filter((candidate) =>
          isVisible(candidate) && /^(?:nombre de )?(?:pi[èe]ces?|chambres?)$/iu.test(accessibleName(candidate)),
        );
        if (rangeHeadings.length === 1) return current;
        if (rangeHeadings.length > 1) break;
      }
      if (current === root) break;
    }
  }
  return undefined;
}

function findRangeChoiceTarget(
  root: ParentNode,
  headingPattern: RegExp,
  value: number,
  mode: "select" | "deselect",
): { root: HTMLElement; button: HTMLElement } | undefined {
  const section = findRangeSection(root, headingPattern);
  const sectionButton = section ? findRangeChoiceButton(section, value, mode) : undefined;
  if (section && sectionButton) return { root: section, button: sectionButton };

  const rangeHeadings = Array.from(
    root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6, legend, [role='heading']"),
  ).filter((candidate) =>
    isVisible(candidate) && /^(?:nombre de )?(?:pi[èe]ces?|chambres?)$/iu.test(accessibleName(candidate)),
  );
  const buttons = Array.from(root.querySelectorAll<HTMLElement>("button, [role='button']"));
  const targets = rangeHeadings.flatMap((heading, headingIndex) => {
    if (!headingPattern.test(accessibleName(heading))) return [];
    const nextRangeHeading = rangeHeadings[headingIndex + 1];
    const scopedButtons = uniqueRangeActions(buttons.filter((candidate) => {
      if ((heading.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING) === 0) {
        return false;
      }
      if (
        nextRangeHeading &&
        (candidate.compareDocumentPosition(nextRangeHeading) & Node.DOCUMENT_POSITION_FOLLOWING) === 0
      ) {
        return false;
      }
      return isVisible(candidate);
    }));
    const matchingButtons = scopedButtons.filter((candidate) =>
      matchesRangeChoiceButton(candidate, value, mode, root),
    );
    return rankByRenderedPresence(matchingButtons).map((button) => {
      let scopedRoot = heading.parentElement;
      while (scopedRoot && !scopedRoot.contains(button)) scopedRoot = scopedRoot.parentElement;
      return { root: scopedRoot ?? button, button, heading };
    });
  });
  const target = targets
    .map((candidate, index) => ({
      ...candidate,
      index,
      score: renderedPresenceScore(candidate.button) * 10 + renderedPresenceScore(candidate.heading),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0];
  return target ? { root: target.root, button: target.button } : undefined;
}

function findRangeChoiceButton(
  section: ParentNode,
  value: number,
  mode: "select" | "deselect",
): HTMLElement | undefined {
  return rankByRenderedPresence(
    uniqueRangeActions(
      Array.from(section.querySelectorAll<HTMLElement>("button, [role='button']")),
    ).filter((candidate) =>
      matchesRangeChoiceButton(candidate, value, mode, section),
    ),
  )[0];
}

function rankByRenderedPresence<T extends HTMLElement>(candidates: readonly T[]): T[] {
  return candidates
    .map((candidate, index) => ({ candidate, index, score: renderedPresenceScore(candidate) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ candidate }) => candidate);
}

function renderedPresenceScore(element: HTMLElement): number {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return 0;

  const view = element.ownerDocument.defaultView;
  if (!view || view.innerWidth <= 0 || view.innerHeight <= 0) return 1;
  const intersectsViewport = rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < view.innerWidth &&
    rect.top < view.innerHeight;
  return intersectsViewport ? 2 : 1;
}

function matchesRangeChoiceButton(
  candidate: HTMLElement,
  value: number,
  mode: "select" | "deselect",
  scope: ParentNode = candidate,
): boolean {
  const expected = Math.max(1, Math.min(8, Math.trunc(value)));
  const observed = rangeChoiceValue(candidate) ?? associatedRangeChoiceValue(candidate, scope);
  if (!isVisible(candidate) || observed !== expected) return false;
  return mode === "deselect" ? isRangeChoiceSelected(candidate) : !isRangeChoiceSelected(candidate);
}

function uniqueRangeActions(candidates: readonly HTMLElement[]): HTMLElement[] {
  return [...new Set(candidates.map(choiceClickTarget))]
    .filter((candidate) => isVisible(candidate) && (
      isRangeChoiceAction(candidate) || (
        rangeChoiceValue(candidate) !== undefined && hasRangeSelectionSemantics(candidate)
      )
    ));
}

function hasRangeSelectionSemantics(element: HTMLElement): boolean {
  return element.hasAttribute("aria-pressed") ||
    element.hasAttribute("aria-checked") ||
    element.hasAttribute("aria-selected") ||
    (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio"));
}

function associatedRangeChoiceValue(
  candidate: HTMLElement,
  scope: ParentNode,
): number | undefined {
  for (let current = candidate.parentElement; current; current = current.parentElement) {
    if (!containsNode(scope, current)) break;
    const actions = uniqueRangeActions(
      Array.from(current.querySelectorAll<HTMLElement>("button, [role='button']")),
    );
    if (actions.length > 1) return undefined;
    if (actions.length === 1 && actions[0] === choiceClickTarget(candidate)) {
      const values = rangeValues(visibleText(current));
      if (values.length === 1) return values[0];
      if (values.length > 1) return undefined;
    }
    if (current === scope) break;
  }
  return undefined;
}

function isRangeChoiceAction(element: HTMLElement): boolean {
  return /^(?:s[ée]lectionner|d[ée]s[ée]lectionner)(?:\s|$)/iu.test(accessibleName(element));
}

function findRangeFilterTrigger(root: ParentNode, headingPattern: RegExp): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>("button, [role='button'], [role='combobox']")).find(
    (candidate) => {
      if (!isVisible(candidate)) return false;
      const name = accessibleName(candidate);
      return /ouvrir.*filtre/iu.test(name) && headingPattern.test(name.replace(/^.*?filtre\s+/iu, ""));
    },
  );
}

function rangeChoiceValue(element: HTMLElement): number | undefined {
  // Leboncoin may expose the action ("Sélectionner") through aria-label and
  // render the numeric value only in a nested span. Do not let the explicit
  // accessible label hide that visible value from the native range driver.
  const candidateText = [
    accessibleName(element),
    visibleText(element),
    element.getAttribute("value") ?? "",
    element.getAttribute("data-value") ?? "",
  ].join(" ");
  return rangeValues(candidateText).at(-1);
}

function rangeValues(value: string): number[] {
  return [...new Set(Array.from(
    value.matchAll(/(?:^|\D)([1-8])\s*\+?(?=\D|$)/gu),
    (match) => Number(match[1]),
  ))];
}

function isRangeChoiceSelected(element: HTMLElement): boolean {
  return isSelected(element) || /^d[ée]s[ée]lectionner\b/iu.test(accessibleName(element));
}

function findByAccessibleName<T extends HTMLElement>(
  root: ParentNode,
  candidateSelector: string,
  namePatterns: readonly RegExp[],
  fallbackSelectors: readonly string[],
): T | undefined {
  const accessible = Array.from(root.querySelectorAll<T>(candidateSelector)).find(
    (element) => isVisible(element) && namePatterns.some((pattern) => pattern.test(accessibleName(element))),
  );
  if (accessible) return accessible;

  for (const selector of fallbackSelectors) {
    const fallback = Array.from(root.querySelectorAll<T>(selector))
      .find((element) => element.matches(candidateSelector) && isVisible(element));
    if (fallback) return fallback;
  }
  return undefined;
}

function accessibleName(element: Element): string {
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) return cleanText(ariaLabel);

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const labels = labelledBy
      .split(/\s+/u)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent)
      .filter((text): text is string => Boolean(text));
    if (labels.length > 0) return cleanText(labels.join(" "));
  }

  if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
    const labels = Array.from(element.labels ?? []).map((label) => label.textContent ?? "");
    if (labels.length > 0) return cleanText(labels.join(" "));
    const placeholder = element.getAttribute("placeholder");
    if (placeholder) return cleanText(placeholder);
  }


  const containingLabel = element.closest("label");
  if (containingLabel) return cleanText(containingLabel.textContent ?? "");

  const describedBy = element.getAttribute("aria-describedby");
  if (describedBy) {
    const descriptions = describedBy
      .split(/\s+/u)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent)
      .filter((text): text is string => Boolean(text));
    if (descriptions.length > 0) return cleanText(descriptions.join(" "));
  }

  return cleanText(element.getAttribute("title") ?? element.textContent ?? "");
}

function visibleText(element: Element): string {
  return cleanText((element as HTMLElement).innerText ?? element.textContent ?? "");
}

function cleanText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizeText(value: string): string {
  return cleanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("fr-FR")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function matchesLocationValue(value: string, query: string): boolean {
  const normalizedValue = normalizeText(value);
  const normalizedQuery = normalizeText(query);
  return Boolean(
    normalizedQuery &&
    (normalizedValue === normalizedQuery || normalizedValue.startsWith(`${normalizedQuery} `)),
  );
}

function numericInputMatches(value: string, expected: number): boolean {
  const normalized = value.replace(/[^\d-]+/gu, "");
  return normalized !== "" && Number(normalized) === Math.trunc(expected);
}

function exactTextPattern(value: string): RegExp {
  return new RegExp(`^${escapeRegExp(value)}$`, "iu");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement) || !element.isConnected) return false;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.hidden || current.getAttribute("aria-hidden") === "true") return false;
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) return false;
  }
  return true;
}

function assertVisible(element: HTMLElement): void {
  if (!isVisible(element) || element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") {
    throw new Error("A required native control is not visible or enabled.");
  }
}

function isEnabledPaginationControl(element: HTMLElement): boolean {
  if (
    !isVisible(element) ||
    element.hasAttribute("disabled") ||
    element.getAttribute("aria-disabled") === "true"
  ) return false;

  if (element instanceof HTMLAnchorElement) {
    const href = element.getAttribute("href")?.trim();
    if (!href || href === "#" || /^javascript:/iu.test(href)) return false;
  }
  return true;
}

function choiceClickTarget(element: HTMLElement): HTMLElement {
  if (
    element instanceof HTMLLabelElement &&
    element.control instanceof HTMLElement &&
    isVisible(element.control)
  ) return element.control;
  return element;
}

function choiceStateTarget(element: HTMLElement): HTMLElement {
  if (element instanceof HTMLLabelElement && element.control instanceof HTMLElement) return element.control;
  return element;
}

function isSelected(element: HTMLElement): boolean {
  if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) {
    return element.checked;
  }
  return element.getAttribute("aria-checked") === "true" ||
    element.getAttribute("aria-selected") === "true" ||
    element.getAttribute("aria-pressed") === "true";
}

function mayNavigateBeforeSearchSubmission(element: HTMLElement): boolean {
  const navigationTarget = element.closest<HTMLElement>("a[href], [role='link'][href]");
  const submitsForm = element instanceof HTMLButtonElement &&
    (element.type === "submit" || element.getAttribute("formaction") !== null);
  const inputSubmitsForm = element instanceof HTMLInputElement &&
    (element.type === "submit" || element.type === "image");
  return Boolean(navigationTarget || submitsForm || inputSubmitsForm);
}

function assertNonNavigatingAction(element: HTMLElement, description: string): void {
  if (mayNavigateBeforeSearchSubmission(element)) {
    throw new Error(`The native home ${description} control may navigate before search submission.`);
  }
}

function setNativeInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
}

function noOpAction(response: NativeSearchResponse): ArmedNativeAction {
  return { response, execute: async () => undefined };
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}
