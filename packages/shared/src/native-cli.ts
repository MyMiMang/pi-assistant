/** 原生 ACP 服务卡片的公开状态；不包含账户或认证秘密。 */
export interface NativeCliStatus {
 installed: boolean;
 platformSupported?: boolean;
 authType?: "agent" | "terminal" | "api-key";
 loggedIn: boolean;
 registered: boolean;
 loginUnverified?: boolean;
 version?: string;
 latestVersion?: string;
 updateAvailable?: boolean;
 updateBlocked?: string;
 verified?: boolean;
 untestedVersion?: boolean;
 error?: string;
 authMethods?: Array<{ id: string; name: string }>;
 operation?: "install" | "update" | "login";
}
export interface NativeCliActionResult { started?: boolean; ok?: boolean }
