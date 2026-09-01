import { calculateMarkerRatios } from './marker'

const rect = {
  left: 50,
  top: 25,
  width: 400,
  height: 300,
}

describe('calculateMarkerRatios', () => {
  it('共有画面内のクリック位置を左上基準の相対座標へ変換する', () => {
    expect(calculateMarkerRatios(250, 175, rect)).toEqual({
      xRatio: 0.5,
      yRatio: 0.5,
    })
  })

  it('共有画面の外側をクリックしても相対座標を0から1に収める', () => {
    expect(calculateMarkerRatios(10, 400, rect)).toEqual({
      xRatio: 0,
      yRatio: 1,
    })
  })
})
