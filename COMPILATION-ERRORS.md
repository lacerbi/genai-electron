# TypeScript Compilation Errors to Fix

> **Status**: ~25 errors remaining (as of 2025-10-16)
> **Severity**: Minor - mostly unused variables, readonly type issues, and null safety checks

---

## Summary by Category

### 1. Unused Variables/Imports (5 errors)
- `src/managers/StorageManager.ts:19` - `getFileSize` imported but never used
- `src/system/SystemInfo.ts:13` - `hasSufficientMemory` imported but never used
- `src/system/SystemInfo.ts:16` - `MODEL_SIZE_ESTIMATES` declared but never used

**Fix**: Remove unused imports or prefix with underscore if intended for future use

### 2. Readonly Array Type Issues (6 errors)
- `src/system/SystemInfo.ts:220,223,226,229,232,235` - Cannot assign readonly arrays to mutable `string[]`

**Fix**: Change type in `src/system/SystemInfo.ts` from `string[]` to `readonly string[]` OR convert readonly arrays to mutable in `src/config/defaults.ts`

### 3. Possibly Undefined Values (10 errors)
- `src/system/gpu-detect.ts:63,90,91,150,151,184,191,236` - Object properties possibly undefined
- `src/system/memory-detect.ts:90,91` - String possibly undefined
- `src/process/log-manager.ts:191,198` - `levelStr` possibly undefined

**Fix**: Add null checks or optional chaining (`?.`) before accessing properties

### 4. Duplicate Property (1 error)
- `src/process/health-check.ts:74` - `status` specified more than once

**Fix**: Rename one of the status variables to avoid conflict

### 5. Platform Type Mismatch (3 errors)
- `src/utils/platform-utils.ts:154,158,160,162` - Record<Platform, string> missing some platform types

**Fix**: Either add all platform types or change type definition to be more permissive

---

## Detailed Error List

### File: src/managers/StorageManager.ts
```
Line 19: 'getFileSize' is declared but its value is never read
```
**Fix**: Remove from import statement

### File: src/process/health-check.ts
```
Line 74: 'status' is specified more than once, so this usage will be overwritten
```
**Fix**: Change line 74 to use different variable name or restructure object spread

### File: src/process/log-manager.ts
```
Line 191: 'levelStr' is possibly 'undefined'
Line 198: Type 'string | undefined' is not assignable to type 'string'
```
**Fix**: Add null check:
```typescript
const levelStr = match?.[2];
if (!levelStr) return null;
const level = levelStr.trim().toLowerCase() as LogLevel;
```

### File: src/system/SystemInfo.ts
```
Lines 13, 16: Unused imports
Lines 220-235: Readonly array type mismatch (6 occurrences)
```
**Fix**:
1. Remove unused imports
2. Change return type from `string[]` to `readonly string[]` in `generateRecommendations()` return type

### File: src/system/gpu-detect.ts
```
Lines 63,90,91,150,151,184,191,236: Object is possibly 'undefined'
```
**Fix**: Add null checks before accessing match groups:
```typescript
const match = stdout.match(/pattern/);
if (!match || !match[1]) return null;
const value = match[1].trim();
```

### File: src/system/memory-detect.ts
```
Lines 90,91: Object is possibly 'undefined'
```
**Fix**: Add null checks for regex match groups

### File: src/utils/platform-utils.ts
```
Line 154: Missing properties from Record<Platform, string>
Lines 158,160,162: Unused '@ts-expect-error' directives
```
**Fix**: Add missing platform entries or change type to `Partial<Record<Platform, string>>`

---

## Quick Fix Script

The following changes can be made in batch:

1. **Remove unused imports**:
   - Remove `getFileSize` from `src/managers/StorageManager.ts`
   - Remove `hasSufficientMemory` and `MODEL_SIZE_ESTIMATES` from `src/system/SystemInfo.ts`

2. **Fix readonly arrays**:
   - Change `recommendedQuantization: string[]` to `recommendedQuantization: readonly string[]` in SystemRecommendations type

3. **Add null checks**:
   - Add `if (!match || !match[N])` checks before accessing regex match groups in gpu-detect.ts and memory-detect.ts
   - Add null check for `levelStr` in log-manager.ts

4. **Fix platform types**:
   - Change `Record<Platform, string>` to `Partial<Record<Platform, string>>` in platform-utils.ts

---

## Recommended Approach

**Option 1: Fix all errors now** (recommended for clean build)
- Systematically fix all 25 errors
- Takes ~30 minutes
- Results in clean TypeScript build

**Option 2: Defer non-critical fixes**
- Fix only blocking errors (none currently blocking)
- Use `@ts-expect-error` or `@ts-ignore` for warnings
- Clean up later during Phase 3

**Option 3: Use strict: false temporarily**
- Modify tsconfig.json to be less strict
- NOT RECOMMENDED - defeats purpose of TypeScript

---

## Notes

All errors are minor and don't affect runtime functionality. They are primarily:
- TypeScript strict mode checks (good practice to fix)
- Unused code (clean up recommended)
- Null safety (important for robustness)

None are blocking compilation - the code will transpile with errors, but it's best practice to have a clean build.
