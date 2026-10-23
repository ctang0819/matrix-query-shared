import crypto from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export class MatrixQueryError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "MatrixQueryError";
    this.code = options.code || "MATRIX_ERROR";
    this.target = options.target || null;
    this.hint = options.hint || null;
    this.candidates = options.candidates || null;
  }
}

if (process.env.MATRIX_IGNORE_TLS !== "false") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

export class MatrixClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || "https://release.zy91.com:4443";
    this.apiPrefix = options.apiPrefix || "/v1";
    this.dataQueryPath = options.dataQueryPath || "/matrix/DBMS/data-query";
    this.fetch = options.fetch || globalThis.fetch;
    this.proxy = options.proxy || null;
    this.ignoreTls = options.ignoreTls ?? process.env.MATRIX_IGNORE_TLS !== "false";
    this.token = null;
    this.authInfo = null;
    this.userInfo = null;
    this.cookieJar = "";
  }

  static sha1(value) {
    return crypto.createHash("sha1").update(value).digest("hex");
  }

  static encryptPassword(value, publicKey) {
    if (!publicKey || typeof publicKey !== "string") {
      throw new Error("This Matrix endpoint requires an RSA public key, but did not return one.");
    }
    let key = publicKey.trim().replace(/\\n/g, "\n");
    if (!key.startsWith("-----BEGIN")) {
      const der = /^[0-9a-f]+$/i.test(key) && key.length % 2 === 0
        ? Buffer.from(key, "hex")
        : Buffer.from(key, "base64");
      try {
        key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
      } catch {
        key = crypto.createPublicKey({ key: der, format: "der", type: "pkcs1" });
      }
    }
    return crypto.publicEncrypt(
      { key, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(String(value), "utf8")
    ).toString("base64");
  }

  exportSession() {
    return {
      baseUrl: this.baseUrl,
      dataQueryPath: this.dataQueryPath,
      proxy: this.proxy,
      token: this.token,
      authInfo: this.authInfo,
      userInfo: this.userInfo,
      cookieJar: this.cookieJar,
    };
  }

  importSession(session = {}) {
    this.baseUrl = session.baseUrl || this.baseUrl;
    this.dataQueryPath = session.dataQueryPath || this.dataQueryPath;
    // Keep proxy settings from the active profile.
    this.token = session.token || null;
    this.authInfo = session.authInfo || null;
    this.userInfo = session.userInfo || null;
    this.cookieJar = session.cookieJar || "";
  }

  async requestViaCurl(url, options = {}) {
    const args = [
      "--silent",
      "--show-error",
      "--location",
      "--dump-header",
      "-",
      "--request",
      options.method || "GET",
    ];
    if (this.ignoreTls) {
      args.push("--insecure");
    }
    if (this.proxy?.host && this.proxy?.port) {
      const proxyScheme = this.proxy.scheme || "socks5";
      args.push("--proxy", `${proxyScheme}://${this.proxy.host}:${this.proxy.port}`);
      if (this.proxy.username || this.proxy.password) {
        args.push("--proxy-user", `${this.proxy.username || ""}:${this.proxy.password || ""}`);
      }
    }

    const headers = options.headers || {};
    for (const [key, value] of Object.entries(headers)) {
      args.push("--header", `${key}: ${value}`);
    }
    if (options.body != null) {
      args.push("--data-binary", options.body);
    }
    args.push(url);

    const { stdout } = await execFile("curl", args, {
      maxBuffer: 20 * 1024 * 1024,
      encoding: "utf8",
      signal: options.signal,
      timeout: 30000,
    });

    const normalized = stdout.replace(/\r\n/g, "\n");
    const sections = normalized.split(/\n(?=HTTP\/)/);
    const finalSection = sections.at(-1) || normalized;
    const headerEnd = finalSection.indexOf("\n\n");
    const rawHeaders = headerEnd >= 0 ? finalSection.slice(0, headerEnd) : finalSection;
    const body = headerEnd >= 0 ? finalSection.slice(headerEnd + 2) : "";
    const headerLines = rawHeaders.split("\n").filter(Boolean);
    const statusLine = headerLines.shift() || "HTTP/1.1 500";
    const status = Number(statusLine.split(/\s+/)[1] || 500);
    const headerMap = new Map();
    const setCookies = [];
    for (const line of headerLines) {
      const colonIndex = line.indexOf(":");
      if (colonIndex < 0) continue;
      const key = line.slice(0, colonIndex).trim().toLowerCase();
      const value = line.slice(colonIndex + 1).trim();
      if (key === "set-cookie") {
        setCookies.push(value);
      }
      if (headerMap.has(key)) {
        headerMap.set(key, `${headerMap.get(key)}, ${value}`);
      } else {
        headerMap.set(key, value);
      }
    }

    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get(name) {
          return headerMap.get(String(name).toLowerCase()) || null;
        },
        getSetCookie() {
          return setCookies;
        },
      },
      text: async () => body,
    };
  }

  mergeCookies(setCookieHeaders = []) {
    const cookieMap = new Map();
    if (this.cookieJar) {
      for (const part of this.cookieJar.split(/;\s*/).filter(Boolean)) {
        const [name, ...rest] = part.split("=");
        cookieMap.set(name, rest.join("="));
      }
    }
    for (const header of setCookieHeaders) {
      const [cookiePart] = header.split(";");
      const [name, ...rest] = cookiePart.split("=");
      cookieMap.set(name, rest.join("="));
    }
    this.cookieJar = Array.from(cookieMap.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  async request(path, options = {}) {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const headers = {
      accept: "application/json",
      ...(options.headers || {}),
    };

    if (this.cookieJar) {
      headers.cookie = this.cookieJar;
    }
    if (this.token && !headers.token) {
      headers.token = this.token;
    }
    if (this.authInfo && !headers.authinfo) {
      headers.authinfo = this.authInfo;
    }

    const response = this.proxy
      ? await this.requestViaCurl(url, {
          method: options.method || "GET",
          headers,
          body: options.body,
          signal: options.signal || AbortSignal.timeout(30000),
        })
      : await this.fetch(url, {
          method: options.method || "GET",
          headers,
          body: options.body,
          signal: options.signal || AbortSignal.timeout(30000),
          redirect: "manual",
        });

    const setCookie = [];
    if (typeof response.headers.getSetCookie === "function") {
      setCookie.push(...response.headers.getSetCookie());
    } else {
      const single = response.headers.get("set-cookie");
      if (single) {
        setCookie.push(...single.split(/\n(?=[^;\n]+=)/));
      }
    }
    if (setCookie.length) {
      this.mergeCookies(setCookie);
    }

    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}

    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      text,
      json,
    };
  }

  async bootstrapCookies() {
    const redirectUrl = `${this.baseUrl}${this.dataQueryPath}`;
    await this.request(`/login?redirect=${encodeURIComponent(redirectUrl)}`);
  }

  async getPasswordMode() {
    const response = await this.request("/apex/sso/password-mode/v2");
    return response.json;
  }

  async login({ username, password }) {
    await this.bootstrapCookies();
    const passwordModeResponse = await this.getPasswordMode();
    const passwordMode = Number(passwordModeResponse?.data?.passwordMode ?? 0);
    const encodedPassword = passwordMode === 0
      ? MatrixClient.sha1(password)
      : passwordMode === 1
        ? MatrixClient.encryptPassword(password, passwordModeResponse?.data?.pubKey)
        : null;
    if (!encodedPassword) {
      throw new Error(`Unsupported Matrix password mode: ${passwordMode}`);
    }
    const body = {
      accountNo: username,
      password: encodedPassword,
      passwordMode,
    };
    const response = await this.request("/apex/sso/login/v2", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        referer: `${this.baseUrl}/login?redirect=${encodeURIComponent(
          `${this.baseUrl}${this.dataQueryPath}`
        )}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.json?.success) {
      throw new Error(response.json?.message || response.text || "Login failed");
    }
    this.token = response.json.data?.token || null;
    this.authInfo = response.json.data?.authInfo || null;
    return response.json;
  }

  async getLoginUserInfo() {
    const response = await this.request("/kapi/apex-sso/getLoginUserInfo", {
      method: "POST",
    });
    if (response.json?.success) {
      this.userInfo = response.json.data;
      this.token = this.userInfo?.token || this.token;
      this.authInfo = this.userInfo?.authInfo || this.authInfo;
    }
    return response.json;
  }

  async listEnvironments() {
    const response = await this.request(
      "/v1/appManage/env/list/withScene?envModel=currency-deploy&scene=dmpEnv"
    );
    return response.json?.data?.envs || [];
  }

  async findEnvironmentByName(name) {
    const envs = await this.listEnvironments();
    return envs.find((item) => item.envName === name) || null;
  }

  async listClusters() {
    const response = await this.request("/matrix-dbms/v1/cluster/list");
    return response.json?.data?.dataSource || [];
  }

  async findClusterByName(name) {
    const clusters = await this.listClusters();
    return clusters.find((item) => item.name === name) || null;
  }

  async listInstances({ envCode, clusterProperty = "mysql", needFilter = true }) {
    const response = await this.request(
      `/matrix-dmp${this.apiPrefix}/dmp/instance/list?envCode=${encodeURIComponent(
        envCode
      )}&clusterProperty=${encodeURIComponent(
        clusterProperty
      )}&needFilter=${encodeURIComponent(String(needFilter))}`,
      {
        headers: {
          referer: `${this.baseUrl}/matrix/DBMS/data-query`,
        },
      }
    );
    return response.json?.data?.dataSource || [];
  }

  async listDatabasesWithSplit({ instanceId, needFilter = true }) {
    const response = await this.request(
      `/matrix-dmp${this.apiPrefix}/dmp/instance/databasesWithSplit?instanceId=${encodeURIComponent(
        instanceId
      )}&needFilter=${encodeURIComponent(String(needFilter))}`,
      {
        headers: {
          referer: `${this.baseUrl}/matrix/DBMS/data-query`,
        },
      }
    );
    return response.json?.data?.SplitDatabaseInfos || [];
  }

  async listLegacyDatabases(clusterId) {
    const response = await this.request(
      `/matrix-dbms/v1/account/getTableColumnList?clusterId=${encodeURIComponent(
        clusterId
      )}&dbName=`
    );
    return response.json;
  }

  async listTables(clusterId, dbName) {
    const response = await this.request(
      `/matrix-dmp${this.apiPrefix}/dmp/instance/database/tables?dbCode=${encodeURIComponent(
        dbName
      )}&instanceId=${encodeURIComponent(
        clusterId
      )}&needFilter=true`,
      {
        headers: {
          referer: `${this.baseUrl}/matrix/DBMS/data-query`,
        },
      }
    );
    return response.json?.data?.tables || [];
  }

  async listColumns(clusterId, dbName, tableName) {
    const response = await this.request(
      `/matrix-dmp${this.apiPrefix}/dmp/instance/database/table/fields?dbCode=${encodeURIComponent(
        dbName
      )}&instanceId=${encodeURIComponent(
        clusterId
      )}&tableCode=${encodeURIComponent(tableName)}`,
      {
        headers: {
          referer: `${this.baseUrl}/matrix/DBMS/data-query`,
        },
      }
    );
    return response.json?.data?.fields || [];
  }

  async getQueryLogs(sqlContent = "") {
    const response = await this.request(
      `/matrix-dmp/v1/dmp/sql/query/logs?pageIndex=1&pageSize=20&sqlContent=${encodeURIComponent(
        sqlContent
      )}`
    );
    return response.json;
  }

  async checkSql({ envCode, instanceId, dbCode, sqlContent, tableCode }) {
    const response = await this.request("/matrix-dmp/v1/dmp/sql/check", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        referer: `${this.baseUrl}/matrix/DBMS/data-query`,
      },
      body: JSON.stringify({
        envCode,
        instanceId,
        dbCode,
        sqlContent,
        tableCode,
      }),
    });
    return response.json;
  }

  async querySql({ envCode, instanceId, dbCode, sqlContent, tableCode, signal }) {
    const response = await this.request("/matrix-dmp/v1/dmp/sql/query", {
      signal,
      method: "POST",
      headers: {
        "content-type": "application/json",
        referer: `${this.baseUrl}/matrix/DBMS/data-query`,
      },
      body: JSON.stringify({
        envCode,
        instanceId,
        dbCode,
        sqlContent,
        ...(tableCode ? { tableCode } : {}),
      }),
    });

    if (!response.json?.success) {
      return response.json;
    }

    const rawRows = response.json?.data?.result || "[]";
    let rows = [];
    try {
      rows = JSON.parse(rawRows);
    } catch {
      rows = [];
    }

    return {
      ...response.json,
      data: {
        ...response.json.data,
        rows,
      },
    };
  }

  async queryRows(options) {
    const result = await this.querySql(options);
    if (!result?.success) {
      throw new Error(result?.errorMsg || "Matrix SQL query failed");
    }
    return result.data?.rows || [];
  }
}
