/**
 * The accounts plugins sign in with, and how: an OAuth sign-in page in the system browser (Chrome
 * Custom Tabs / ASWebAuthenticationSession) that redirects back into the app, a hosted MCP server
 * (which the app registers with by itself, so it needs no setup), GitHub's device code, a token
 * pasted from the service's settings, or nothing at all.
 *
 * OAuth client IDs come from `.env.local` (EXPO_PUBLIC_*, inlined by Expo CLI; only the literal
 * `process.env.EXPO_PUBLIC_X` form is inlined, so don't destructure them), and people can enter
 * their own on a provider's setup screen instead. All are public clients using PKCE, no secrets.
 */
export type ProviderId =
  | 'google'
  | 'microsoft'
  | 'github'
  | 'notion'
  | 'linear'
  | 'figma'
  | 'todoist'
  | 'asana'
  | 'clickup'
  | 'airtable'
  | 'dropbox'
  | 'spotify'
  | 'atlassian'
  | 'miro'
  | 'calendly'
  | 'granola'
  | 'jotform'
  | 'attio'
  | 'make'
  | 'paypal'
  | 'sentry'
  | 'supabase'
  | 'netlify'
  | 'neon'
  | 'huggingface'
  | 'webflow'
  | 'wix'
  | 'context7'
  | 'excalidraw'
  | 'deepwiki'
  | 'none';

export type OAuthConfig = {
  kind: 'oauth';
  authorizeUrl: string;
  tokenUrl: string;
  /**
   * Where the browser returns: "app" is clanker://oauth/<provider>; "google" is the reversed client
   * ID scheme Google's iOS-type clients redirect to, which app.config.js registers in the build.
   */
  redirect: 'app' | 'google';
  /** Asked for on every sign-in, beside the plugins' own scopes. */
  baseScopes: string[];
  params?: Record<string, string>;
  /** Revokes a token when disconnecting, if the provider has a revocation endpoint. */
  revokeUrl?: string;
};

export type TokenConfig = {
  kind: 'token';
  /** Where the user makes the token. */
  tokenUrl: string;
  /** How, in a few short steps. */
  steps: string[];
  placeholder: string;
};

export type DeviceConfig = {
  kind: 'device';
  deviceUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Used when no OAuth client is set up. */
  token: TokenConfig;
};

/**
 * A hosted MCP server. The app registers itself with the server's authorization server (dynamic
 * client registration), signs in with PKCE in the system browser, and offers the server's own
 * tools, named <prefix>_<tool>. Servers that need no account skip the sign-in.
 */
export type McpConfig = { kind: 'mcp'; url: string; prefix: string; /** Needs no account. */ open?: boolean };

export type ProviderDef = {
  id: ProviderId;
  title: string;
  auth: OAuthConfig | DeviceConfig | TokenConfig | McpConfig | { kind: 'none' };
  /** How requests carry the token. Default "Authorization: Bearer <token>". */
  authHeader?: (token: string) => Record<string, string>;
  /** Sent with every API request. */
  headers?: Record<string, string>;
  /** Looks up the account's name and address after connecting. */
  whoami?: { url: string; method?: 'GET' | 'POST'; body?: string; headers?: Record<string, string>; pick: (json: any) => { name?: string; email?: string } };
  /** Built-in OAuth client, from .env.local. */
  builtInClient?: { id: string };
  /** For the setup screen when people bring their own OAuth client. */
  setup?: { consoleUrl: string; steps: string[] };
  /** Where people manage or remove the access they gave. */
  manageUrl?: string;
};

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  google: {
    id: 'google',
    title: 'Google',
    auth: {
      kind: 'oauth',
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      redirect: 'google',
      baseScopes: ['openid', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'],
      // include_granted_scopes keeps what earlier plugins were granted, so adding one asks only for its own access.
      params: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
      revokeUrl: 'https://oauth2.googleapis.com/revoke',
    },
    whoami: {
      url: 'https://openidconnect.googleapis.com/v1/userinfo',
      pick: (j) => ({ name: j.name, email: j.email }),
    },
    builtInClient: { id: process.env.EXPO_PUBLIC_GOOGLE_PLUGIN_CLIENT_ID ?? '' },
    setup: {
      consoleUrl: 'https://console.cloud.google.com/apis/credentials',
      steps: [
        'In Google Cloud Console, enable the Gmail, Calendar, Drive, Docs, Sheets, Slides and Tasks APIs.',
        'Set up the OAuth consent screen and add your Google account as a test user.',
        'Create an OAuth client of type “iOS” (it works for Android too) with the bundle ID com.danie4588e.Clanker.',
        'Google returns to the app on a scheme made from the client ID, which must be built in: put the ID in .env.local as EXPO_PUBLIC_GOOGLE_PLUGIN_CLIENT_ID and make a new build.',
      ],
    },
    manageUrl: 'https://myaccount.google.com/connections',
  },
  microsoft: {
    id: 'microsoft',
    title: 'Microsoft',
    auth: {
      kind: 'oauth',
      authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      redirect: 'app',
      baseScopes: ['offline_access', 'openid', 'profile', 'email', 'User.Read'],
      params: { prompt: 'select_account' },
    },
    whoami: {
      url: 'https://graph.microsoft.com/v1.0/me',
      pick: (j) => ({ name: j.displayName, email: j.mail ?? j.userPrincipalName }),
    },
    builtInClient: { id: process.env.EXPO_PUBLIC_MICROSOFT_CLIENT_ID ?? '' },
    setup: {
      consoleUrl: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
      steps: [
        'In Microsoft Entra, register an app for “Accounts in any organizational directory and personal Microsoft accounts”.',
        'Under Authentication, add a “Mobile and desktop applications” platform with the custom redirect URI below.',
        'Copy the Application (client) ID here. No secret is needed.',
      ],
    },
    manageUrl: 'https://account.live.com/consent/Manage',
  },
  github: {
    id: 'github',
    title: 'GitHub',
    auth: {
      kind: 'device',
      deviceUrl: 'https://github.com/login/device/code',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      scopes: ['repo', 'read:user'],
      token: {
        kind: 'token',
        tokenUrl: 'https://github.com/settings/tokens/new?scopes=repo,read:user&description=Clanker',
        steps: [
          'Open GitHub’s new token page (signed in).',
          'Keep the repo and read:user scopes, pick an expiry, and generate the token. (A fine-grained token works too, with Contents and Issues read/write, and Pull requests and Metadata read.)',
          'Copy it and paste it here.',
        ],
        placeholder: 'ghp_… or github_pat_…',
      },
    },
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    whoami: { url: 'https://api.github.com/user', pick: (j) => ({ name: j.name || j.login, email: j.login ? `@${j.login}` : undefined }) },
    builtInClient: { id: process.env.EXPO_PUBLIC_GITHUB_CLIENT_ID ?? '' },
    setup: {
      consoleUrl: 'https://github.com/settings/applications/new',
      steps: ['Register a new OAuth app on GitHub (any homepage and callback URL).', 'Tick “Enable Device Flow”.', 'Copy its Client ID here. No secret is needed.'],
    },
    manageUrl: 'https://github.com/settings/applications',
  },
  notion: {
    id: 'notion',
    title: 'Notion',
    auth: { kind: 'mcp', url: 'https://mcp.notion.com/mcp', prefix: 'notion' },
    manageUrl: 'https://www.notion.so/profile/integrations',
  },
  linear: {
    id: 'linear',
    title: 'Linear',
    auth: { kind: 'mcp', url: 'https://mcp.linear.app/mcp', prefix: 'linear' },
    manageUrl: 'https://linear.app/settings/account/security',
  },
  figma: {
    id: 'figma',
    title: 'Figma',
    auth: {
      kind: 'token',
      tokenUrl: 'https://www.figma.com/settings',
      steps: [
        'Open Figma’s settings and go to Security.',
        'Generate a personal access token with the scopes current_user:read, file_content:read, file_comments:read and file_comments:write.',
        'Copy it and paste it here.',
      ],
      placeholder: 'figd_…',
    },
    authHeader: (token) => ({ 'X-Figma-Token': token }),
    whoami: { url: 'https://api.figma.com/v1/me', pick: (j) => ({ name: j.handle, email: j.email }) },
    manageUrl: 'https://www.figma.com/settings',
  },
  todoist: {
    id: 'todoist',
    title: 'Todoist',
    auth: { kind: 'mcp', url: 'https://ai.todoist.net/mcp', prefix: 'todoist' },
    manageUrl: 'https://app.todoist.com/app/settings/integrations/connected',
  },
  asana: {
    id: 'asana',
    title: 'Asana',
    auth: {
      kind: 'token',
      tokenUrl: 'https://app.asana.com/0/my-apps',
      steps: ['Open Asana’s developer console.', 'Create a new personal access token.', 'Copy it and paste it here.'],
      placeholder: '2/1234…',
    },
    whoami: { url: 'https://app.asana.com/api/1.0/users/me', pick: (j) => ({ name: j.data?.name, email: j.data?.email }) },
    manageUrl: 'https://app.asana.com/0/my-apps',
  },
  clickup: {
    id: 'clickup',
    title: 'ClickUp',
    auth: { kind: 'mcp', url: 'https://mcp.clickup.com/mcp', prefix: 'clickup' },
    manageUrl: 'https://app.clickup.com/settings/apps',
  },
  airtable: {
    id: 'airtable',
    title: 'Airtable',
    auth: {
      kind: 'token',
      tokenUrl: 'https://airtable.com/create/tokens/new',
      steps: [
        'Open Airtable’s new personal access token page.',
        'Add the scopes data.records:read, data.records:write, schema.bases:read and user.email:read, and the bases to allow.',
        'Create the token, copy it and paste it here.',
      ],
      placeholder: 'pat…',
    },
    whoami: { url: 'https://api.airtable.com/v0/meta/whoami', pick: (j) => ({ email: j.email }) },
    manageUrl: 'https://airtable.com/create/tokens',
  },
  dropbox: {
    id: 'dropbox',
    title: 'Dropbox',
    auth: {
      kind: 'oauth',
      authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
      tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
      redirect: 'app',
      baseScopes: [],
      params: { token_access_type: 'offline' },
      revokeUrl: 'https://api.dropboxapi.com/2/auth/token/revoke',
    },
    whoami: {
      url: 'https://api.dropboxapi.com/2/users/get_current_account',
      method: 'POST',
      pick: (j) => ({ name: j.name?.display_name, email: j.email }),
    },
    builtInClient: { id: process.env.EXPO_PUBLIC_DROPBOX_CLIENT_ID ?? '' },
    setup: {
      consoleUrl: 'https://www.dropbox.com/developers/apps/create',
      steps: [
        'Create a Dropbox app with Scoped access and Full Dropbox.',
        'On its Permissions tab, tick account_info.read, files.metadata.read, files.content.read, files.content.write, sharing.read and sharing.write.',
        'On Settings, add the redirect URI below and copy the App key here.',
      ],
    },
    manageUrl: 'https://www.dropbox.com/account/connected_apps',
  },
  spotify: {
    id: 'spotify',
    title: 'Spotify',
    auth: {
      kind: 'oauth',
      authorizeUrl: 'https://accounts.spotify.com/authorize',
      tokenUrl: 'https://accounts.spotify.com/api/token',
      redirect: 'app',
      baseScopes: [],
    },
    whoami: { url: 'https://api.spotify.com/v1/me', pick: (j) => ({ name: j.display_name, email: j.email }) },
    builtInClient: { id: process.env.EXPO_PUBLIC_SPOTIFY_CLIENT_ID ?? '' },
    setup: {
      consoleUrl: 'https://developer.spotify.com/dashboard',
      steps: [
        'Create an app in the Spotify developer dashboard, choosing the Web API.',
        'Add the redirect URI below.',
        'Copy its Client ID here. In development mode the app owner needs Spotify Premium, and up to 5 accounts can use it once added under User Management.',
      ],
    },
    manageUrl: 'https://www.spotify.com/account/apps/',
  },
  atlassian: {
    id: 'atlassian',
    title: 'Atlassian',
    auth: { kind: 'mcp', url: 'https://mcp.atlassian.com/v1/mcp', prefix: 'atlassian' },
    manageUrl: 'https://id.atlassian.com/manage-profile/apps',
  },
  miro: {
    id: 'miro',
    title: 'Miro',
    auth: { kind: 'mcp', url: 'https://mcp.miro.com/', prefix: 'miro' },
  },
  calendly: {
    id: 'calendly',
    title: 'Calendly',
    auth: { kind: 'mcp', url: 'https://mcp.calendly.com', prefix: 'calendly' },
  },
  granola: {
    id: 'granola',
    title: 'Granola',
    auth: { kind: 'mcp', url: 'https://mcp.granola.ai/mcp', prefix: 'granola' },
  },
  jotform: {
    id: 'jotform',
    title: 'Jotform',
    auth: { kind: 'mcp', url: 'https://mcp.jotform.com/', prefix: 'jotform' },
  },
  attio: {
    id: 'attio',
    title: 'Attio',
    auth: { kind: 'mcp', url: 'https://mcp.attio.com/mcp', prefix: 'attio' },
  },
  make: {
    id: 'make',
    title: 'Make',
    auth: { kind: 'mcp', url: 'https://mcp.make.com', prefix: 'make' },
  },
  paypal: {
    id: 'paypal',
    title: 'PayPal',
    auth: { kind: 'mcp', url: 'https://mcp.paypal.com/mcp', prefix: 'paypal' },
  },
  sentry: {
    id: 'sentry',
    title: 'Sentry',
    auth: { kind: 'mcp', url: 'https://mcp.sentry.dev/mcp', prefix: 'sentry' },
  },
  supabase: {
    id: 'supabase',
    title: 'Supabase',
    auth: { kind: 'mcp', url: 'https://mcp.supabase.com/mcp', prefix: 'supabase' },
  },
  netlify: {
    id: 'netlify',
    title: 'Netlify',
    auth: { kind: 'mcp', url: 'https://netlify-mcp.netlify.app/mcp', prefix: 'netlify' },
  },
  neon: {
    id: 'neon',
    title: 'Neon',
    auth: { kind: 'mcp', url: 'https://mcp.neon.tech/mcp', prefix: 'neon' },
  },
  huggingface: {
    id: 'huggingface',
    title: 'Hugging Face',
    auth: { kind: 'mcp', url: 'https://huggingface.co/mcp', prefix: 'hf', open: true },
  },
  webflow: {
    id: 'webflow',
    title: 'Webflow',
    auth: { kind: 'mcp', url: 'https://mcp.webflow.com/mcp', prefix: 'webflow' },
  },
  wix: {
    id: 'wix',
    title: 'Wix',
    auth: { kind: 'mcp', url: 'https://mcp.wix.com/mcp', prefix: 'wix' },
  },
  context7: {
    id: 'context7',
    title: 'Context7',
    auth: { kind: 'mcp', url: 'https://mcp.context7.com/mcp', prefix: 'context7', open: true },
  },
  excalidraw: {
    id: 'excalidraw',
    title: 'Excalidraw',
    auth: { kind: 'mcp', url: 'https://mcp.excalidraw.com/mcp', prefix: 'excalidraw', open: true },
  },
  deepwiki: {
    id: 'deepwiki',
    title: 'DeepWiki',
    auth: { kind: 'mcp', url: 'https://mcp.deepwiki.com/mcp', prefix: 'deepwiki', open: true },
  },
  none: { id: 'none', title: 'No account', auth: { kind: 'none' } },
};
