package expo.modules.clankerscroll

import android.content.Context
import android.view.View
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.views.ExpoView

/**
 * Sits between a scroll view and an inverted list it's nested in. Android hands the scroll a nested
 * view can't use on to the scroll view around it as a raw distance, which an inverted list (drawn
 * upside down) applies backwards. This takes the hand-off in place of the list and passes it on
 * with the vertical direction turned around; flings too.
 *
 * Flipping the nested view to match the list instead gets the direction right, but the nested view
 * then corrects the finger's position by how far the list moved it on screen, which is in screen
 * terms and so backwards in the flipped view's own, and the scroll stutters at its ends.
 */
class InvertedScrollRelayView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val consumed = IntArray(2)
  private var atTop = false
  private var atBottom = false
  private var mode = MODE_UNDECIDED

  init {
    isNestedScrollingEnabled = true
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), MeasureSpec.getSize(heightMeasureSpec))
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    // Yoga lays out the nested ScrollView directly; prevent ExpoView's LinearLayout from overriding it.
  }

  private fun decideMode(deltaY: Float) {
    if (mode != MODE_UNDECIDED || deltaY == 0f) return
    mode = if ((deltaY > 0f && atBottom) || (deltaY < 0f && atTop)) MODE_OUTER else MODE_INNER
  }

  override fun onStartNestedScroll(child: View, target: View, axes: Int): Boolean =
    axes and View.SCROLL_AXIS_VERTICAL != 0

  override fun onNestedScrollAccepted(child: View, target: View, axes: Int) {
    super.onNestedScrollAccepted(child, target, axes)
    atTop = !target.canScrollVertically(-1)
    atBottom = !target.canScrollVertically(1)
    mode = MODE_UNDECIDED
    startNestedScroll(View.SCROLL_AXIS_VERTICAL)
  }

  override fun onStopNestedScroll(target: View) {
    super.onStopNestedScroll(target)
    mode = MODE_UNDECIDED
    stopNestedScroll()
  }

  override fun onNestedPreScroll(target: View, dx: Int, dy: Int, out: IntArray) {
    decideMode(dy.toFloat())
    if (mode != MODE_OUTER) return
    consumed[0] = 0
    consumed[1] = 0
    if (dispatchNestedPreScroll(dx, -dy, consumed, null)) {
      out[0] = consumed[0]
      out[1] = -consumed[1]
    }
  }

  override fun onNestedScroll(target: View, dxConsumed: Int, dyConsumed: Int, dxUnconsumed: Int, dyUnconsumed: Int) {
    if (mode == MODE_UNDECIDED) {
      if (dyConsumed != 0) mode = MODE_INNER
      else decideMode(dyUnconsumed.toFloat())
    }
    if (mode != MODE_OUTER) return
    dispatchNestedScroll(dxConsumed, -dyConsumed, dxUnconsumed, -dyUnconsumed, null)
  }

  override fun onNestedPreFling(target: View, velocityX: Float, velocityY: Float): Boolean {
    decideMode(velocityY)
    return if (mode == MODE_OUTER) dispatchNestedPreFling(velocityX, -velocityY) else false
  }

  override fun onNestedFling(target: View, velocityX: Float, velocityY: Float, consumed: Boolean): Boolean {
    decideMode(velocityY)
    return if (mode == MODE_OUTER) dispatchNestedFling(velocityX, -velocityY, consumed) else false
  }

  companion object {
    private const val MODE_UNDECIDED = 0
    private const val MODE_INNER = 1
    private const val MODE_OUTER = 2
  }
}

class ClankerScrollModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ClankerScroll")

    View(InvertedScrollRelayView::class) {}
  }
}
