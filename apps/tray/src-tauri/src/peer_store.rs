//! One opaque desktop-peer vault for the current OS user. This module never
//! falls back to files or subprocesses. Callers must serialize read/modify/save
//! sequences; a save replaces the entire blob, not individual peers.

/// Returns `Ok(None)` only when the vault entry is missing.
pub fn load() -> Result<Option<Vec<u8>>, String> {
    platform::load()
}

/// Creates or replaces the vault entry. An empty blob is not a deletion.
pub fn save(data: &[u8]) -> Result<(), String> {
    platform::save(data)
}

#[cfg(any(target_os = "macos", target_os = "windows", test))]
mod bytes {
    // Supply a real address even for an empty write; some update APIs use null
    // to mean "do not change the value".
    pub(super) fn input(data: &[u8]) -> *const u8 {
        static EMPTY: u8 = 0;
        if data.is_empty() {
            &EMPTY
        } else {
            data.as_ptr()
        }
    }

    /// The caller must keep the OS allocation alive and guarantee any non-null,
    /// nonempty range is initialized and readable for `len` bytes.
    pub(super) unsafe fn copy(ptr: *const u8, len: usize) -> Result<Vec<u8>, String> {
        if len == 0 {
            return Ok(Vec::new());
        }
        if ptr.is_null() || len > isize::MAX as usize {
            return Err("desktop peer vault returned an invalid blob".into());
        }
        Ok(unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::ptr::null;

        #[test]
        fn copies_opaque_bytes() {
            let blob = [0, 0xff, 0x80, 0x41];
            assert_eq!(unsafe { copy(input(&blob), blob.len()) }.unwrap(), blob);
        }

        #[test]
        fn distinguishes_empty_from_invalid_data() {
            assert!(!input(&[]).is_null());
            assert!(unsafe { copy(null(), 0) }.unwrap().is_empty());
            assert!(unsafe { copy(null(), 1) }.is_err());
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::bytes;
    use std::{
        ffi::c_void,
        ptr::{null, null_mut, NonNull},
    };

    // Use the file-based default user Keychain, not the entitlement-gated
    // Data Protection Keychain. Pin lookup and creation to the same keychain.
    const SERVICE: &[u8] = b"com.piassistant.app.desktop-peer";
    const ACCOUNT: &[u8] = b"vault";
    const ERR_ITEM_NOT_FOUND: i32 = -25300;
    const ERR_DUPLICATE_ITEM: i32 = -25299;

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecKeychainCopyDefault(keychain: *mut *mut c_void) -> i32;
        fn SecKeychainFindGenericPassword(
            keychain_or_array: *const c_void,
            service_len: u32,
            service: *const u8,
            account_len: u32,
            account: *const u8,
            data_len: *mut u32,
            data: *mut *mut c_void,
            item: *mut *mut c_void,
        ) -> i32;
        fn SecKeychainAddGenericPassword(
            keychain: *mut c_void,
            service_len: u32,
            service: *const u8,
            account_len: u32,
            account: *const u8,
            data_len: u32,
            data: *const c_void,
            item: *mut *mut c_void,
        ) -> i32;
        fn SecKeychainItemModifyAttributesAndData(
            item: *mut c_void,
            attributes: *const c_void,
            data_len: u32,
            data: *const c_void,
        ) -> i32;
        fn SecKeychainItemFreeContent(attributes: *mut c_void, data: *mut c_void) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(value: *const c_void);
    }

    struct OwnedRef(NonNull<c_void>);
    impl Drop for OwnedRef {
        fn drop(&mut self) {
            // SAFETY: owned reference returned by Security under the Copy rule
            // or as a retained item output.
            unsafe { CFRelease(self.0.as_ptr()) };
        }
    }

    struct PasswordData(*mut c_void);
    impl Drop for PasswordData {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: this is the buffer from FindGenericPassword.
                unsafe { SecKeychainItemFreeContent(null_mut(), self.0) };
            }
        }
    }

    fn check(op: &str, status: i32) -> Result<(), String> {
        if status == 0 {
            Ok(())
        } else {
            Err(format!("desktop peer Keychain {op} failed (OSStatus {status})"))
        }
    }

    fn default_keychain() -> Result<OwnedRef, String> {
        let mut keychain = null_mut();
        // SAFETY: writable out parameter; the result is owned on success.
        check("open", unsafe { SecKeychainCopyDefault(&mut keychain) })?;
        NonNull::new(keychain)
            .map(OwnedRef)
            .ok_or_else(|| "desktop peer default Keychain is unavailable".into())
    }

    pub(super) fn load() -> Result<Option<Vec<u8>>, String> {
        let keychain = default_keychain()?;
        let mut len = 0;
        let mut data = PasswordData(null_mut());
        // SAFETY: both names have explicit lengths and outputs are writable;
        // the optional item output is omitted.
        let status = unsafe {
            SecKeychainFindGenericPassword(
                keychain.0.as_ptr(),
                SERVICE.len() as u32,
                SERVICE.as_ptr(),
                ACCOUNT.len() as u32,
                ACCOUNT.as_ptr(),
                &mut len,
                &mut data.0,
                null_mut(),
            )
        };
        if status == ERR_ITEM_NOT_FOUND {
            return Ok(None);
        }
        check("read", status)?;
        // SAFETY: Security returned the buffer and length; data owns it during the copy.
        unsafe { bytes::copy(data.0.cast(), len as usize) }.map(Some)
    }

    pub(super) fn save(data: &[u8]) -> Result<(), String> {
        let len = u32::try_from(data.len())
            .map_err(|_| "desktop peer blob is too large for Keychain".to_string())?;
        let keychain = default_keychain()?;
        let ptr = bytes::input(data).cast();
        // SAFETY: all inputs stay alive for this call; no item output requested.
        let status = unsafe {
            SecKeychainAddGenericPassword(
                keychain.0.as_ptr(),
                SERVICE.len() as u32,
                SERVICE.as_ptr(),
                ACCOUNT.len() as u32,
                ACCOUNT.as_ptr(),
                len,
                ptr,
                null_mut(),
            )
        };
        if status != ERR_DUPLICATE_ITEM {
            return check("create", status);
        }

        let mut item = null_mut();
        // SAFETY: same lookup scope and identity as load; request only the
        // retained item reference, not a copy of the old secret.
        check("find for update", unsafe {
            SecKeychainFindGenericPassword(
                keychain.0.as_ptr(),
                SERVICE.len() as u32,
                SERVICE.as_ptr(),
                ACCOUNT.len() as u32,
                ACCOUNT.as_ptr(),
                null_mut(),
                null_mut(),
                &mut item,
            )
        })?;
        let item = NonNull::new(item)
            .map(OwnedRef)
            .ok_or_else(|| "desktop peer Keychain returned no item to update".to_string())?;
        // SAFETY: live item and input buffer; null attributes preserves metadata/ACL.
        check("update", unsafe {
            SecKeychainItemModifyAttributesAndData(item.0.as_ptr(), null(), len, ptr)
        })
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::bytes;
    use std::{
        ffi::c_void,
        io,
        ptr::{null_mut, NonNull},
    };

    const TARGET: &str = "com.piassistant.app.desktop-peer/vault";
    const CRED_TYPE_GENERIC: u32 = 1;
    // Despite the name, persists only for the same user on this computer.
    const CRED_PERSIST_LOCAL_MACHINE: u32 = 2;
    const ERROR_NOT_FOUND: i32 = 1168;
    const MAX_BLOB_SIZE: usize = 5 * 512; // CRED_MAX_CREDENTIAL_BLOB_SIZE

    // Windows CREDENTIALW layout, including its two-DWORD FILETIME.
    #[repr(C)]
    struct Credential {
        flags: u32,
        kind: u32,
        target_name: *mut u16,
        comment: *mut u16,
        last_written: [u32; 2],
        blob_size: u32,
        blob: *mut u8,
        persist: u32,
        attribute_count: u32,
        attributes: *mut c_void,
        target_alias: *mut u16,
        user_name: *mut u16,
    }

    #[link(name = "advapi32")]
    extern "system" {
        fn CredReadW(target: *const u16, kind: u32, flags: u32, out: *mut *mut Credential) -> i32;
        fn CredWriteW(credential: *const Credential, flags: u32) -> i32;
        fn CredFree(buffer: *mut c_void);
    }

    struct OwnedCredential(NonNull<Credential>);
    impl Drop for OwnedCredential {
        fn drop(&mut self) {
            // SAFETY: CredReadW allocates the record and all its fields as one buffer.
            unsafe { CredFree(self.0.as_ptr().cast()) };
        }
    }

    fn target() -> Vec<u16> {
        TARGET.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn check_size(len: usize) -> Result<u32, String> {
        if len > MAX_BLOB_SIZE {
            Err(format!("desktop peer vault exceeds the Windows limit of {MAX_BLOB_SIZE} bytes"))
        } else {
            Ok(len as u32)
        }
    }

    pub(super) fn load() -> Result<Option<Vec<u8>>, String> {
        let target = target();
        let mut raw = null_mut();
        // SAFETY: target is NUL-terminated and raw is a writable output pointer.
        if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut raw) } == 0 {
            let code = io::Error::last_os_error().raw_os_error();
            return if code == Some(ERROR_NOT_FOUND) {
                Ok(None)
            } else {
                Err(format!("desktop peer Credential Manager read failed (Win32 {code:?})"))
            };
        }
        let credential = NonNull::new(raw)
            .map(OwnedCredential)
            .ok_or_else(|| "desktop peer Credential Manager returned no record".to_string())?;
        // SAFETY: CredReadW succeeded and the owner keeps the record and blob alive.
        let record = unsafe { credential.0.as_ref() };
        let len = record.blob_size as usize;
        check_size(len)?;
        unsafe { bytes::copy(record.blob, len) }.map(Some)
    }

    pub(super) fn save(data: &[u8]) -> Result<(), String> {
        let blob_size = check_size(data.len())?;
        let mut target = target();
        let record = Credential {
            flags: 0,
            kind: CRED_TYPE_GENERIC,
            target_name: target.as_mut_ptr(),
            comment: null_mut(),
            last_written: [0; 2],
            blob_size,
            blob: bytes::input(data).cast_mut(),
            persist: CRED_PERSIST_LOCAL_MACHINE,
            attribute_count: 0,
            attributes: null_mut(),
            target_alias: null_mut(),
            user_name: null_mut(), // ignored for a generic credential
        };
        // SAFETY: CredWriteW reads the input record and buffers synchronously;
        // CREDENTIALW's mutable pointer types do not imply writes to the blob.
        if unsafe { CredWriteW(&record, 0) } == 0 {
            let code = io::Error::last_os_error().raw_os_error();
            Err(format!("desktop peer Credential Manager write failed (Win32 {code:?})"))
        } else {
            Ok(())
        }
    }

    #[cfg(test)]
    #[test]
    fn blob_size_is_checked_before_conversion() {
        assert_eq!(check_size(0).unwrap(), 0);
        assert_eq!(check_size(MAX_BLOB_SIZE).unwrap(), 2560);
        assert!(check_size(MAX_BLOB_SIZE + 1).is_err());
        assert!(check_size(usize::MAX).is_err());
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    const UNSUPPORTED: &str = "desktop peer protected storage is unsupported on this OS";

    pub(super) fn load() -> Result<Option<Vec<u8>>, String> {
        Err(UNSUPPORTED.into())
    }

    pub(super) fn save(_: &[u8]) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
}
