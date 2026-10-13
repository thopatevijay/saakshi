'use client';

/**
 * Edit one camera (D4-20) — the manual-add dialog's fields and validation, prefilled, saved with
 * `PATCH /api/v1/cameras/:id`.
 *
 * The camera id is not editable: it is the upsert key the catalogue sync and bulk import match on.
 * Validation runs in `parseCameraEdit` before anything is sent, and every message sits under its
 * own field. On success the saved row is handed back through `onSaved`, so the table and the map
 * update from the API's response without a reload — a tray camera given coordinates moves onto the
 * map at once.
 */
import { useActionState, useEffect } from 'react';
import { updateCamera } from './actions';
import { INPUT, Row } from './manual-add-dialog';
import type { Camera, EditCameraState } from './types';
import {
  ADAPTER_KINDS,
  CAMERA_MOUNTS,
  CAMERA_TYPES,
  GEOMETRY_CLASSES,
  STORAGE_TYPES,
} from '@/src/lib/registry/query';

const INITIAL: EditCameraState = { saved: null, error: null, fieldErrors: {}, values: null };

function Options({ values }: { values: readonly string[] }) {
  return values.map((value) => (
    <option key={value} value={value}>
      {value.replaceAll('_', ' ')}
    </option>
  ));
}

function Fields({
  camera,
  errors,
  submitted,
}: {
  camera: Camera;
  errors: Record<string, string>;
  submitted: Record<string, string> | null;
}) {
  // A rejected form shows what was typed (React resets an action form to its defaults).
  const pick = (name: keyof Camera, value: string | number | null) =>
    submitted?.[name] ?? (value === null ? '' : String(value));
  return (
    <>
      <Row label="Name *" error={errors['name']}>
        <input name="name" defaultValue={pick('name', camera.name)} className={INPUT} />
      </Row>
      <Row label="District" error={errors['district']}>
        <input name="district" defaultValue={pick('district', camera.district)} className={INPUT} />
      </Row>
      <Row
        label="Latitude"
        hint="Without coordinates the camera cannot be mapped."
        error={errors['lat']}
      >
        <input
          name="lat"
          inputMode="decimal"
          defaultValue={pick('lat', camera.lat)}
          className={INPUT}
        />
      </Row>
      <Row label="Longitude" error={errors['lon']}>
        <input
          name="lon"
          inputMode="decimal"
          defaultValue={pick('lon', camera.lon)}
          className={INPUT}
        />
      </Row>
      <Row label="Address" error={errors['address']}>
        <input name="address" defaultValue={pick('address', camera.address)} className={INPUT} />
      </Row>
      <Row label="Adapter" error={errors['adapterKind']}>
        <select
          name="adapterKind"
          defaultValue={pick('adapterKind', camera.adapterKind)}
          className={INPUT}
        >
          <Options values={ADAPTER_KINDS} />
        </select>
      </Row>
      <Row label="Camera type" error={errors['cameraType']}>
        <select
          name="cameraType"
          defaultValue={pick('cameraType', camera.cameraType)}
          className={INPUT}
        >
          <Options values={CAMERA_TYPES} />
        </select>
      </Row>
      <Row label="Mount" error={errors['mount']}>
        <select name="mount" defaultValue={pick('mount', camera.mount)} className={INPUT}>
          <Options values={CAMERA_MOUNTS} />
        </select>
      </Row>
      <Row label="Geometry class" error={errors['geometryClass']}>
        <select
          name="geometryClass"
          defaultValue={pick('geometryClass', camera.geometryClass)}
          className={INPUT}
        >
          <Options values={GEOMETRY_CLASSES} />
        </select>
      </Row>
      <Row label="Vendor" error={errors['vendor']}>
        <input name="vendor" defaultValue={pick('vendor', camera.vendor)} className={INPUT} />
      </Row>
      <Row label="VMS" error={errors['vmsPlatform']}>
        <input
          name="vmsPlatform"
          defaultValue={pick('vmsPlatform', camera.vmsPlatform)}
          className={INPUT}
        />
      </Row>
      <Row label="Retention (days)" error={errors['retentionDays']}>
        <input
          name="retentionDays"
          inputMode="numeric"
          defaultValue={pick('retentionDays', camera.retentionDays)}
          className={INPUT}
        />
      </Row>
      <Row label="Storage type" error={errors['storageType']}>
        <select
          name="storageType"
          defaultValue={pick('storageType', camera.storageType)}
          className={INPUT}
        >
          <option value="">unknown</option>
          <Options values={STORAGE_TYPES} />
        </select>
      </Row>
    </>
  );
}

export function EditCameraDialog({
  camera,
  onClose,
  onSaved,
}: {
  camera: Camera;
  onClose: () => void;
  onSaved: (camera: Camera) => void;
}) {
  const [state, formAction, pending] = useActionState(updateCamera.bind(null, camera.id), INITIAL);

  useEffect(() => {
    if (state.saved !== null) onSaved(state.saved);
  }, [state.saved, onSaved]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-camera-heading"
      data-testid="edit-camera-dialog"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/70 px-4 py-10 backdrop-blur-sm"
    >
      <div className="w-full max-w-xl rounded-lg border border-slate-800 bg-slate-950 shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-slate-800 px-6 py-4">
          <div>
            <h2 id="edit-camera-heading" className="text-sm font-semibold text-slate-100">
              Edit {camera.externalId}
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              Every saved change is written to the audit chain with your badge and the fields
              changed.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
          >
            Close
          </button>
        </header>

        <form action={formAction} noValidate className="grid grid-cols-2 gap-x-4 gap-y-3 px-6 py-5">
          <Fields camera={camera} errors={state.fieldErrors} submitted={state.values} />
          <div className="col-span-2 flex items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={pending}
              className="rounded-md bg-sky-700 px-4 py-2 text-xs font-medium text-white hover:bg-sky-600 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
            >
              {pending ? 'Saving…' : 'Save changes'}
            </button>
            {state.error === null ? null : (
              <p role="alert" className="text-xs text-rose-300">
                {state.error}
              </p>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
