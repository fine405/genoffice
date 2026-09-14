import { useState, type CSSProperties } from 'react'
import ReactCrop from 'react-image-crop'
import 'react-image-crop/dist/ReactCrop.css'
import type { CropBox, PickerImage, Region } from './types'
import { cropFromPercent, cropToPercent, editableCrop } from './crop'
import { fontPickerStrings } from './strings'

export const regionStyle = (number: number): CSSProperties =>
  ({ '--selection-stroke': `var(--font-region-${((number - 1) % 8) + 1})` }) as CSSProperties

function SelectionFrame() {
  return (
    <span className="font-selection-frame" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  )
}

export function ImageStage({
  image,
  regions,
  selectedId,
  busy,
  crop,
  editing,
  lang,
  onCrop,
  onEdit,
  onCancel,
  onSelect,
}: {
  image: PickerImage
  regions: Region[]
  selectedId: string
  busy: boolean
  crop: CropBox | null
  editing: boolean
  lang: string
  onCrop: (crop: CropBox | null) => void
  onEdit: (region?: Region) => void
  onCancel: () => void
  onSelect: (region: Region) => void
}) {
  const t = fontPickerStrings(lang)
  const [zoom, setZoom] = useState(100)
  const [showRegions, setShowRegions] = useState(true)
  const selected = regions.find((region) => region.id === selectedId)
  const picture = (
    <div className="font-picker-image">
      <img src={image.dataUrl} alt={t.reference} draggable={false} />
      {!editing &&
        showRegions &&
        regions.map((region) => (
          <button
            key={region.id}
            type="button"
            className={`font-picker-region${selectedId === region.id ? ' selected' : ''}`}
            aria-label={`${region.number}. ${region.text}`}
            aria-pressed={selectedId === region.id}
            disabled={busy}
            style={{
              ...regionStyle(region.number),
              left: `${(region.box.left / image.input_image.width) * 100}%`,
              top: `${(region.box.top / image.input_image.height) * 100}%`,
              width: `${(region.box.width / image.input_image.width) * 100}%`,
              height: `${(region.box.height / image.input_image.height) * 100}%`,
            }}
            onClick={() => onSelect(region)}
          >
            <SelectionFrame />
            <span
              className={`font-region-number${region.box.top / image.input_image.height < 0.06 ? ' inside' : ''}`}
            >
              {String(region.number).padStart(2, '0')}
            </span>
          </button>
        ))}
    </div>
  )
  return (
    <>
      <div className="font-picker-image-scroll">
        <div
          className="font-picker-image-size"
          style={{
            width: `${zoom}%`,
            maxWidth: `${(((360 * image.input_image.width) / image.input_image.height) * zoom) / 100}px`,
          }}
        >
          {editing ? (
            <ReactCrop
              className="font-reference-crop"
              crop={
                crop
                  ? cropToPercent(crop, image.input_image.width, image.input_image.height)
                  : undefined
              }
              onChange={(_, percent) =>
                onCrop(cropFromPercent(percent, image.input_image.width, image.input_image.height))
              }
              disabled={busy}
              keepSelection
              ariaLabels={{
                cropArea: t.cropArea,
                nwDragHandle: t.nwHandle,
                nDragHandle: t.nHandle,
                neDragHandle: t.neHandle,
                eDragHandle: t.eHandle,
                seDragHandle: t.seHandle,
                sDragHandle: t.sHandle,
                swDragHandle: t.swHandle,
                wDragHandle: t.wHandle,
              }}
              renderSelectionAddon={() => <SelectionFrame />}
            >
              {picture}
            </ReactCrop>
          ) : (
            picture
          )}
        </div>
      </div>
      <div
        className="font-picker-tools font-picker-image-tools"
        role="toolbar"
        aria-label={t.imageTools}
      >
        <button disabled={busy} onClick={() => onEdit()}>
          {t.addRegion}
        </button>
        {selected && !editing && (
          <button
            disabled={busy}
            onClick={() => {
              onEdit(selected)
              onCrop(editableCrop(selected.box, image.input_image.width, image.input_image.height))
            }}
          >
            {t.editRegion}
          </button>
        )}
        {editing && (
          <button disabled={busy} onClick={onCancel}>
            {t.cancelCrop}
          </button>
        )}
        {!editing && regions.length > 0 && (
          <button
            disabled={busy}
            aria-pressed={showRegions}
            onClick={() => setShowRegions(!showRegions)}
          >
            {showRegions ? t.hideRegions : t.showRegions}
          </button>
        )}
        <label className="font-picker-zoom">
          <input
            type="range"
            min="100"
            max="300"
            step="25"
            value={zoom}
            aria-label={t.zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
          />
          {zoom}%
        </label>
      </div>
      <p className="font-picker-hint">
        {editing ? t.crop : t.pickRegion}
        {editing && crop ? ` · ${crop.width} × ${crop.height} px` : ''}
      </p>
    </>
  )
}
