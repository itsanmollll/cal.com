import prismock from "../../../../tests/libs/__mocks__/prisma";
import oAuthManagerMock, { defaultMockOAuthManager } from "../../tests/__mocks__/OAuthManager";
import { adminMock, calendarMock, setCredentialsMock } from "./__mocks__/googleapis";

import { JWT } from "googleapis-common";
import { expect, test, beforeEach, vi, describe } from "vitest";
import "vitest-fetch-mock";

import { CalendarCache } from "@calcom/features/calendar-cache/calendar-cache";
import { getTimeMin, getTimeMax } from "@calcom/features/calendar-cache/lib/datesForCache";
import { SelectedCalendarRepository } from "@calcom/lib/server/repository/selectedCalendar";
import type { CredentialForCalendarServiceWithEmail } from "@calcom/types/Credential";

import CalendarService from "./CalendarService";
import { getGoogleAppKeys } from "./getGoogleAppKeys";

vi.stubEnv("GOOGLE_WEBHOOK_TOKEN", "test-webhook-token");

interface MockJWT {
  type: "jwt";
  config: {
    email: string;
    key: string;
    scopes: string[];
    subject: string;
  };
  authorize: () => Promise<void>;
}

interface MockOAuth2Client {
  type: "oauth2";
  args: [string, string, string];
  setCredentials: typeof setCredentialsMock;
}

let lastCreatedJWT: MockJWT | null = null;
let lastCreatedOAuth2Client: MockOAuth2Client | null = null;

vi.mock("@calcom/features/flags/server/utils", () => ({
  getFeatureFlag: vi.fn().mockReturnValue(true),
}));

vi.mock("./getGoogleAppKeys", () => ({
  getGoogleAppKeys: vi.fn().mockResolvedValue({
    client_id: "xxxxxxxxxxxxxxxxxxxxxxxxxx.apps.googleusercontent.com",
    client_secret: "xxxxxxxxxxxxxxxxxx",
    redirect_uris: ["http://localhost:3000/api/integrations/googlecalendar/callback"],
  }),
}));

vi.mock("googleapis-common", async () => {
  const actual = await vi.importActual("googleapis-common");
  return {
    ...actual,
    OAuth2Client: vi.fn().mockImplementation((...args: [string, string, string]) => {
      lastCreatedOAuth2Client = {
        type: "oauth2",
        args,
        setCredentials: setCredentialsMock,
      };
      return lastCreatedOAuth2Client;
    }),
    JWT: vi.fn().mockImplementation((config: MockJWT["config"]) => {
      lastCreatedJWT = {
        type: "jwt",
        config,
        authorize: vi.fn().mockResolvedValue(undefined),
      };
      return lastCreatedJWT;
    }),
  };
});
vi.mock("@googleapis/admin", () => adminMock);
vi.mock("@googleapis/calendar", () => calendarMock);

beforeEach(() => {
  vi.clearAllMocks();
  setCredentialsMock.mockClear();
  oAuthManagerMock.OAuthManager = defaultMockOAuthManager;
  calendarMock.calendar_v3.Calendar.mockClear();
  adminMock.admin_directory_v1.Admin.mockClear();
});

const googleTestCredentialKey = {
  scope: "https://www.googleapis.com/auth/calendar.events",
  token_type: "Bearer",
  expiry_date: 1625097600000,
  access_token: "",
  refresh_token: "",
};

const getSampleCredential = () => {
  return {
    invalid: false,
    key: googleTestCredentialKey,
    type: "google_calendar",
  };
};

const testSelectedCalendar = {
  userId: 1,
  integration: "google_calendar",
  externalId: "example@cal.com",
};

function expectGoogleSubscriptionToHaveOccurredAndClearMock({ calendarId }: { calendarId: string }) {
  expect(calendarMock.calendar_v3.Calendar().events.watch).toHaveBeenCalledTimes(1);
  expect(calendarMock.calendar_v3.Calendar().events.watch).toHaveBeenCalledWith(
    expect.objectContaining({
      calendarId,
      requestBody: expect.objectContaining({
        type: "web_hook",
        token: process.env.GOOGLE_WEBHOOK_TOKEN,
      }),
    })
  );
  calendarMock.calendar_v3.Calendar().events.watch.mockClear();
}

function expectGoogleSubscriptionToNotHaveOccurredAndClearMock() {
  expect(calendarMock.calendar_v3.Calendar().events.watch).not.toHaveBeenCalled();
  calendarMock.calendar_v3.Calendar().events.watch.mockClear();
}

function expectGoogleUnsubscriptionToHaveOccurredAndClearMock(
  channels: {
    resourceId: string;
    channelId: string;
  }[]
) {
  expect(calendarMock.calendar_v3.Calendar().channels.stop).toHaveBeenCalledTimes(1);
  channels.forEach((channel) => {
    expect(calendarMock.calendar_v3.Calendar().channels.stop).toHaveBeenCalledWith({
      requestBody: {
        resourceId: channel.resourceId,
        id: channel.channelId,
      },
    });
  });
  calendarMock.calendar_v3.Calendar().channels.stop.mockClear();
}

function expectGoogleUnsubscriptionToNotHaveOccurredAndClearMock() {
  expect(calendarMock.calendar_v3.Calendar().channels.stop).not.toHaveBeenCalled();
  calendarMock.calendar_v3.Calendar().channels.stop.mockClear();
}

async function expectSelectedCalendarToHaveGoogleChannelProps(
  id: string,
  googleChannelProps: {
    googleChannelId: string;
    googleChannelKind: string;
    googleChannelResourceId: string;
    googleChannelResourceUri: string;
    googleChannelExpiration: string;
  }
) {
  const selectedCalendar = await SelectedCalendarRepository.findById(id);

  expect(selectedCalendar).toEqual(expect.objectContaining(googleChannelProps));
}

async function expectSelectedCalendarToNotHaveGoogleChannelProps(selectedCalendarId: string) {
  const selectedCalendar = await SelectedCalendarRepository.findFirst({
    where: {
      id: selectedCalendarId,
    },
  });

  expect(selectedCalendar).toEqual(
    expect.objectContaining({
      googleChannelId: null,
      googleChannelKind: null,
      googleChannelResourceId: null,
      googleChannelResourceUri: null,
      googleChannelExpiration: null,
    })
  );
}

test("Calendar Cache is being read on cache HIT", async () => {
  const credentialInDb1 = await createCredentialInDb();
  const dateFrom1 = new Date().toISOString();
  const dateTo1 = new Date().toISOString();

  // Create cache
  const calendarCache = await CalendarCache.init(null);
  await calendarCache.upsertCachedAvailability(
    credentialInDb1.id,
    {
      timeMin: getTimeMin(dateFrom1),
      timeMax: getTimeMax(dateTo1),
      items: [{ id: testSelectedCalendar.externalId }],
    },
    JSON.parse(
      JSON.stringify({
        calendars: [
          {
            busy: [
              {
                start: "2023-12-01T18:00:00Z",
                end: "2023-12-01T19:00:00Z",
              },
            ],
          },
        ],
      })
    )
  );

  oAuthManagerMock.OAuthManager = defaultMockOAuthManager;
  const calendarService = new CalendarService(credentialInDb1);

  // Test cache hit
  const data = await calendarService.getAvailability(dateFrom1, dateTo1, [testSelectedCalendar]);
  expect(data).toEqual([
    {
      start: "2023-12-01T18:00:00Z",
      end: "2023-12-01T19:00:00Z",
    },
  ]);
});

test("Calendar Cache is being ignored on cache MISS", async () => {
  const calendarCache = await CalendarCache.init(null);
  const credentialInDb = await createCredentialInDb();
  const dateFrom = new Date(Date.now()).toISOString();
  // Tweak date so that it's a cache miss
  const dateTo = new Date(Date.now() + 100000000).toISOString();
  const calendarService = new CalendarService(credentialInDb);

  // Test Cache Miss
  await calendarService.getAvailability(dateFrom, dateTo, [testSelectedCalendar]);

  // Expect cache to be ignored in case of a MISS
  const cachedAvailability = await calendarCache.getCachedAvailability(credentialInDb.id, {
    timeMin: dateFrom,
    timeMax: dateTo,
    items: [{ id: testSelectedCalendar.externalId }],
  });

  expect(cachedAvailability).toBeNull();
});

async function expectCacheToBeNotSet({ credentialId }: { credentialId: number }) {
  const caches = await prismock.calendarCache.findMany({
    where: {
      credentialId,
    },
  });

  expect(caches).toHaveLength(0);
}

async function expectCacheToBeSet({
  credentialId,
  itemsInKey,
}: {
  credentialId: number;
  itemsInKey: { id: string }[];
}) {
  const caches = await prismock.calendarCache.findMany({
    where: {
      credentialId,
    },
  });

  expect(caches).toHaveLength(1);
  expect(JSON.parse(caches[0].key)).toEqual(
    expect.objectContaining({
      items: itemsInKey,
    })
  );
}

describe("Watching and unwatching calendar", () => {
  test("Calendar can be watched and unwatched", async () => {
    const credentialInDb1 = await createCredentialInDb();
    const calendarCache = await CalendarCache.initFromCredentialId(credentialInDb1.id);
    await calendarCache.watchCalendar({
      calendarId: testSelectedCalendar.externalId,
      eventTypeIds: [null],
    });
    const watchedCalendar = await prismock.selectedCalendar.findFirst({
      where: {
        userId: credentialInDb1.userId!,
        externalId: testSelectedCalendar.externalId,
        integration: "google_calendar",
      },
    });

    expect(watchedCalendar).toEqual(
      expect.objectContaining({
        userId: 1,
        eventTypeId: null,
        integration: "google_calendar",
        externalId: "example@cal.com",
        credentialId: 1,
        delegationCredentialId: null,
        googleChannelId: "mock-channel-id",
        googleChannelKind: "api#channel",
        googleChannelResourceId: "mock-resource-id",
        googleChannelResourceUri: "mock-resource-uri",
        googleChannelExpiration: "1111111111",
      })
    );

    expect(watchedCalendar?.id).toBeDefined();

    await calendarCache.unwatchCalendar({
      calendarId: testSelectedCalendar.externalId,
      eventTypeIds: [null],
    });
    const calendarAfterUnwatch = await prismock.selectedCalendar.findFirst({
      where: {
        userId: credentialInDb1.userId!,
        externalId: testSelectedCalendar.externalId,
        integration: "google_calendar",
      },
    });

    expect(calendarAfterUnwatch).toEqual(
      expect.objectContaining({
        userId: 1,
        eventTypeId: null,
        integration: "google_calendar",
        externalId: "example@cal.com",
        credentialId: 1,
        delegationCredentialId: null,
        googleChannelId: null,
        googleChannelKind: null,
        googleChannelResourceId: null,
        googleChannelResourceUri: null,
        googleChannelExpiration: null,
      })
    );
    expect(calendarAfterUnwatch?.id).toBeDefined();
  });

  test("watchCalendar should not do google subscription if already subscribed for the same calendarId", async () => {
    const credentialInDb1 = await createCredentialInDb();
    const calendarCache = await CalendarCache.initFromCredentialId(credentialInDb1.id);
    const userLevelCalendar = await SelectedCalendarRepository.create({
      userId: credentialInDb1.userId!,
      externalId: "externalId@cal.com",
      integration: "google_calendar",
      eventTypeId: null,
      credentialId: credentialInDb1.id,
    });

    const eventTypeLevelCalendar = await SelectedCalendarRepository.create({
      userId: credentialInDb1.userId!,
      externalId: "externalId@cal.com",
      integration: "google_calendar",
      eventTypeId: 1,
      credentialId: credentialInDb1.id,
    });

    await calendarCache.watchCalendar({
      calendarId: userLevelCalendar.externalId,
      eventTypeIds: [userLevelCalendar.eventTypeId],
    });

    expectGoogleSubscriptionToHaveOccurredAndClearMock({
      calendarId: userLevelCalendar.externalId,
    });

    await expectSelectedCalendarToHaveGoogleChannelProps(userLevelCalendar.id, {
      googleChannelId: "mock-channel-id",
      googleChannelKind: "api#channel",
      googleChannelResourceId: "mock-resource-id",
      googleChannelResourceUri: "mock-resource-uri",
      googleChannelExpiration: "1111111111",
    });

    // Watch different selectedcalendar with same externalId and credentialId
    await calendarCache.watchCalendar({
      calendarId: eventTypeLevelCalendar.externalId,
      eventTypeIds: [eventTypeLevelCalendar.eventTypeId],
    });

    expectGoogleSubscriptionToNotHaveOccurredAndClearMock();
    // Google Subscription didn't occur but still the eventTypeLevelCalendar has the same googleChannelProps
    await expectSelectedCalendarToHaveGoogleChannelProps(eventTypeLevelCalendar.id, {
      googleChannelId: "mock-channel-id",
      googleChannelKind: "api#channel",
      googleChannelResourceId: "mock-resource-id",
      googleChannelResourceUri: "mock-resource-uri",
      googleChannelExpiration: "1111111111",
    });
  });

  test("unwatchCalendar should not unsubscribe from google if there is another selectedCalendar with same externalId and credentialId", async () => {
    const credentialInDb1 = await createCredentialInDb();
    const calendarCache = await CalendarCache.initFromCredentialId(credentialInDb1.id);

    const concernedCache = await prismock.calendarCache.create({
      data: {
        key: "test-key",
        value: "test-value",
        expiresAt: new Date(Date.now() + 100000000),
        credentialId: credentialInDb1.id,
      },
    });

    const someOtherCache = await prismock.calendarCache.create({
      data: {
        key: JSON.stringify({
          items: [{ id: "someOtherExternalId@cal.com" }],
        }),
        value: "test-value-2",
        expiresAt: new Date(Date.now() + 100000000),
        credentialId: 999,
      },
    });

    const googleChannelProps = {
      googleChannelId: "test-channel-id",
      googleChannelKind: "api#channel",
      googleChannelResourceId: "test-resource-id",
      googleChannelResourceUri: "test-resource-uri",
      googleChannelExpiration: "1111111111",
    };

    const commonProps = {
      userId: credentialInDb1.userId!,
      externalId: "externalId@cal.com",
      integration: "google_calendar",
      credentialId: credentialInDb1.id,
      ...googleChannelProps,
    };

    const userLevelCalendar = await SelectedCalendarRepository.create({
      ...commonProps,
      eventTypeId: null,
    });

    const eventTypeLevelCalendar = await SelectedCalendarRepository.create({
      ...commonProps,
      eventTypeId: 1,
    });

    const eventTypeLevelCalendarForSomeOtherExternalIdButSameCredentialId =
      await SelectedCalendarRepository.create({
        ...commonProps,
        externalId: "externalId2@cal.com",
        eventTypeId: 2,
      });

    await calendarCache.unwatchCalendar({
      calendarId: userLevelCalendar.externalId,
      eventTypeIds: [userLevelCalendar.eventTypeId],
    });
    // There is another selectedCalendar with same externalId and credentialId, so actual unsubscription does not happen
    expectGoogleUnsubscriptionToNotHaveOccurredAndClearMock();
    await expectSelectedCalendarToNotHaveGoogleChannelProps(userLevelCalendar.id);

    await calendarCache.unwatchCalendar({
      calendarId: eventTypeLevelCalendar.externalId,
      eventTypeIds: [eventTypeLevelCalendar.eventTypeId],
    });

    expectGoogleUnsubscriptionToHaveOccurredAndClearMock([
      {
        resourceId: "test-resource-id",
        channelId: "test-channel-id",
      },
    ]);

    // Concerned cache will just have remaining externalIds
    expectCacheToBeSet({
      credentialId: concernedCache.credentialId,
      itemsInKey: [{ id: eventTypeLevelCalendarForSomeOtherExternalIdButSameCredentialId.externalId }],
    });

    expectCacheToBeSet({
      credentialId: someOtherCache.credentialId,
      itemsInKey: JSON.parse(someOtherCache.key).items,
    });

    await expectSelectedCalendarToNotHaveGoogleChannelProps(eventTypeLevelCalendar.id);

    // Some other selectedCalendar stays unaffected
    await expectSelectedCalendarToHaveGoogleChannelProps(
      eventTypeLevelCalendarForSomeOtherExternalIdButSameCredentialId.id,
      googleChannelProps
    );
  });
});
test("fetchAvailabilityAndSetCache should fetch and cache availability for selected calendars grouped by eventTypeId", async () => {
  const credentialInDb = await createCredentialInDb();
  const calendarService = new CalendarService(credentialInDb);

  const selectedCalendars = [
    {
      externalId: "calendar1@test.com",
      eventTypeId: 1,
    },
    {
      externalId: "calendar2@test.com",
      eventTypeId: 1,
    },
    {
      externalId: "calendar1@test.com",
      eventTypeId: 2,
    },
    {
      externalId: "calendar1@test.com",
      eventTypeId: null,
    },
    {
      externalId: "calendar2@test.com",
      eventTypeId: null,
    },
  ];

  const mockAvailabilityData = { busy: [] };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.spyOn(calendarService, "fetchAvailability").mockResolvedValue(mockAvailabilityData as any);
  const setAvailabilityInCacheSpy = vi.spyOn(calendarService, "setAvailabilityInCache");

  await calendarService.fetchAvailabilityAndSetCache(selectedCalendars);

  // Should make 2 calls - one for each unique eventTypeId
  expect(calendarService.fetchAvailability).toHaveBeenCalledTimes(3);

  // First call for eventTypeId 1 calendars
  expect(calendarService.fetchAvailability).toHaveBeenNthCalledWith(1, {
    timeMin: expect.any(String),
    timeMax: expect.any(String),
    items: [{ id: "calendar1@test.com" }, { id: "calendar2@test.com" }],
  });

  // Second call for eventTypeId 2 calendar
  expect(calendarService.fetchAvailability).toHaveBeenNthCalledWith(2, {
    timeMin: expect.any(String),
    timeMax: expect.any(String),
    items: [{ id: "calendar1@test.com" }],
  });

  // Second call for eventTypeId 2 calendar
  expect(calendarService.fetchAvailability).toHaveBeenNthCalledWith(3, {
    timeMin: expect.any(String),
    timeMax: expect.any(String),
    items: [{ id: "calendar1@test.com" }, { id: "calendar2@test.com" }],
  });

  // Should cache results for both calls
  expect(setAvailabilityInCacheSpy).toHaveBeenCalledTimes(3);
  expect(setAvailabilityInCacheSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      items: expect.any(Array),
    }),
    mockAvailabilityData
  );
});

test("`updateTokenObject` should update credential in DB as well as myGoogleAuth", async () => {
  const credentialInDb = await createCredentialInDb();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let updateTokenObject: any;
  oAuthManagerMock.OAuthManager = vi.fn().mockImplementation((arg) => {
    updateTokenObject = arg.updateTokenObject;
    return {
      getTokenObjectOrFetch: vi.fn().mockImplementation(() => {
        return {
          token: {
            access_token: "FAKE_ACCESS_TOKEN",
          },
        };
      }),
      request: vi.fn().mockResolvedValue({
        json: [],
      }),
    };
  });

  const calendarService = new CalendarService(credentialInDb);
  await calendarService.listCalendars();

  const newTokenObject = {
    access_token: "NEW_FAKE_ACCESS_TOKEN",
  };

  // Scenario: OAuthManager causes `updateTokenObject` to be called
  await updateTokenObject(newTokenObject);

  const newCredential = await prismock.credential.findFirst({
    where: {
      id: credentialInDb.id,
    },
  });

  // Expect update in DB
  expect(newCredential).toEqual(
    expect.objectContaining({
      key: newTokenObject,
    })
  );

  // Expect update in myGoogleAuth credentials
  expect(setCredentialsMock).toHaveBeenCalledWith(newTokenObject);
});

async function createCredentialInDb({
  user = undefined,
  delegatedTo = null,
}: {
  user?: { email: string | null };
  delegatedTo?: NonNullable<CredentialForCalendarServiceWithEmail["delegatedTo"]> | null;
} = {}): Promise<CredentialForCalendarServiceWithEmail> {
  const defaultUser = await prismock.user.create({
    data: {
      email: user?.email ?? "",
    },
  });

  const app = await prismock.app.create({
    data: {
      slug: "google-calendar",
      dirName: "google-calendar",
    },
  });

  const credential = {
    ...getSampleCredential(),
    key: {
      ...googleTestCredentialKey,
      expiry_date: Date.now() - 1000,
    },
  };

  const credentialInDb = await prismock.credential.create({
    data: {
      ...credential,
      user: {
        connect: {
          id: defaultUser.id,
        },
      },
      app: {
        connect: {
          slug: app.slug,
        },
      },
    },
    include: {
      user: true,
    },
  });

  return {
    ...credentialInDb,
    delegatedTo: delegatedTo ?? null,
    user: user ? { email: user.email ?? "" } : null,
  } as CredentialForCalendarServiceWithEmail;
}

describe("GoogleCalendarService credential handling", () => {
  beforeEach(() => {
    lastCreatedJWT = null;
    lastCreatedOAuth2Client = null;
  });

  const delegatedCredential = {
    serviceAccountKey: {
      client_email: "service@example.com",
      client_id: "service-client-id",
      private_key: "service-private-key",
    },
  } as const;

  const createMockJWTInstance = ({
    email = "user@example.com",
    authorizeError,
  }: {
    email?: string;
    authorizeError?: { response?: { data?: { error?: string } } } | Error;
  }) => {
    const mockJWTInstance = {
      type: "jwt",
      config: {
        email: delegatedCredential.serviceAccountKey.client_email,
        key: delegatedCredential.serviceAccountKey.private_key,
        scopes: ["https://www.googleapis.com/auth/calendar"],
        subject: email,
      },
      authorize: vi.fn().mockRejectedValue(authorizeError ?? new Error("Default error")),
      createScoped: vi.fn(),
      getRequestMetadataAsync: vi.fn(),
      fetchIdToken: vi.fn(),
      hasUserScopes: vi.fn(),
      getAccessToken: vi.fn(),
      getRefreshToken: vi.fn(),
      getTokenInfo: vi.fn(),
      refreshAccessToken: vi.fn(),
      revokeCredentials: vi.fn(),
      revokeToken: vi.fn(),
      verifyIdToken: vi.fn(),
      on: vi.fn(),
      setCredentials: vi.fn(),
      getCredentials: vi.fn(),
      hasAnyScopes: vi.fn(),
      authorizeAsync: vi.fn(),
      refreshTokenNoCache: vi.fn(),
      createGToken: vi.fn(),
    };

    vi.mocked(JWT).mockImplementation(() => mockJWTInstance as unknown as JWT);
    return mockJWTInstance;
  };

  test("uses JWT auth with impersonation when Delegation credential is provided", async () => {
    const credentialWithDelegation = await createCredentialInDb({
      user: { email: "user@example.com" },
      delegatedTo: delegatedCredential,
    });

    const calendarService = new CalendarService(credentialWithDelegation);
    await calendarService.listCalendars();

    const expectedJWTConfig: MockJWT = {
      type: "jwt",
      config: {
        email: delegatedCredential.serviceAccountKey.client_email,
        key: delegatedCredential.serviceAccountKey.private_key,
        scopes: ["https://www.googleapis.com/auth/calendar"],
        subject: "user@example.com",
      },
      authorize: expect.any(Function) as () => Promise<void>,
    };

    expect(lastCreatedJWT).toEqual(expectedJWTConfig);

    expect(calendarMock.calendar_v3.Calendar).toHaveBeenCalledWith({
      auth: lastCreatedJWT,
    });
  });

  test("uses OAuth2 auth when no Delegation credential is provided", async () => {
    const regularCredential = await createCredentialInDb();
    const { client_id, client_secret, redirect_uris } = await getGoogleAppKeys();

    const calendarService = new CalendarService(regularCredential);
    await calendarService.listCalendars();

    expect(lastCreatedJWT).toBeNull();

    const expectedOAuth2Client: MockOAuth2Client = {
      type: "oauth2",
      args: [client_id, client_secret, redirect_uris[0]],
      setCredentials: setCredentialsMock,
    };

    expect(lastCreatedOAuth2Client).toEqual(expectedOAuth2Client);

    expect(setCredentialsMock).toHaveBeenCalledWith(regularCredential.key);

    expect(calendarMock.calendar_v3.Calendar).toHaveBeenCalledWith({
      auth: lastCreatedOAuth2Client,
    });
  });

  test("handles DelegationCredential authorization errors appropriately", async () => {
    const credentialWithDelegation = await createCredentialInDb({
      user: { email: "user@example.com" },
      delegatedTo: delegatedCredential,
    });

    createMockJWTInstance({
      authorizeError: {
        response: {
          data: {
            error: "unauthorized_client",
          },
        },
      },
    });

    const calendarService = new CalendarService(credentialWithDelegation);

    await expect(calendarService.listCalendars()).rejects.toThrow(
      "Make sure that the Client ID for the delegation credential is added to the Google Workspace Admin Console"
    );
  });

  test("handles invalid_grant error (user not in workspace) appropriately", async () => {
    const credentialWithDelegation = await createCredentialInDb({
      user: { email: "user@example.com" },
      delegatedTo: delegatedCredential,
    });

    createMockJWTInstance({
      authorizeError: {
        response: {
          data: {
            error: "invalid_grant",
          },
        },
      },
    });

    const calendarService = new CalendarService(credentialWithDelegation);

    await expect(calendarService.listCalendars()).rejects.toThrow("User might not exist in Google Workspace");
  });

  test("handles general DelegationCredential authorization errors appropriately", async () => {
    const credentialWithDelegation = await createCredentialInDb({
      user: { email: "user@example.com" },
      delegatedTo: delegatedCredential,
    });

    createMockJWTInstance({
      authorizeError: new Error("Some unexpected error"),
    });

    const calendarService = new CalendarService(credentialWithDelegation);

    await expect(calendarService.listCalendars()).rejects.toThrow("Error authorizing delegation credential");
  });

  test("handles missing user email for DelegationCredential appropriately", async () => {
    const credentialWithDelegation = await createCredentialInDb({
      user: { email: null },
      delegatedTo: delegatedCredential,
    });

    const calendarService = new CalendarService(credentialWithDelegation);
    const { client_id, client_secret, redirect_uris } = await getGoogleAppKeys();

    await calendarService.listCalendars();

    expect(lastCreatedJWT).toBeNull();

    const expectedOAuth2Client: MockOAuth2Client = {
      type: "oauth2",
      args: [client_id, client_secret, redirect_uris[0]],
      setCredentials: setCredentialsMock,
    };

    expect(lastCreatedOAuth2Client).toEqual(expectedOAuth2Client);
  });
});
