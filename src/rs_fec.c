/**
 * Reed-Solomon Forward Error Correction (FEC) Decoder
 *
 * This implementation uses a reverse-engineered Generator Matrix discovered
 * from captured FEC data. The server uses a proprietary encoding different
 * from standard RS Vandermonde.
 *
 * Key findings:
 * 1. GF(256) with polynomial x^8+x^4+x^3+x^2+1 (modulus 0x1d)
 * 2. For rows 0-3: G[i][j] = G[0][(j/4)*4 + ((j%4) XOR i)]
 *    This means rows 0-3 are column permutations of G[0] using XOR pattern
 * 3. Row 4 (G[4]) has a different structure
 *
 * Originally ported from multimedia-ffmpeg-vendor/libavformat/RS_fec.c,
 * then modified to use the solved G matrix.
 */

#include "rs_fec.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const uint8_t RS_MODULUS = 0x1d; /* x^8+x^4+x^3+x^2+1=0 */
static const unsigned int RS_BOUND = 0x100;
static const unsigned int RS_SIZE = 0xFF;

/*
 * Hardcoded G matrix for k=100, m=5
 * Rows 0-3 follow XOR pattern: G[i][j] = G[0][(j/4)*4 + ((j%4) XOR i)]
 * Row 4 has independent values
 */
static const uint8_t fec_g0_k100[100] = {
    0x20, 0x85, 0x89, 0xdf, 0xd0, 0x65, 0xb2, 0xf4, 0x44, 0x56, 0x3f, 0x25,
    0x73, 0x51, 0x48, 0x62, 0x75, 0x74, 0x91, 0x7d, 0xfa, 0xaf, 0x25, 0x9d,
    0xdf, 0x9b, 0x94, 0xc7, 0x53, 0x65, 0xa0, 0x81, 0xde, 0x07, 0xf8, 0x3f,
    0x09, 0x94, 0xdf, 0x5c, 0x7d, 0x3e, 0x24, 0xc5, 0xd4, 0x7c, 0xf4, 0xfe,
    0x71, 0x7f, 0x2d, 0x46, 0x43, 0x0e, 0x10, 0x38, 0xe6, 0xeb, 0x45, 0x90,
    0x25, 0xc2, 0x08, 0x37, 0xe0, 0x9e, 0xb7, 0x84, 0x55, 0x98, 0x50, 0xd0,
    0xf1, 0x15, 0x30, 0xdf, 0xa2, 0x7c, 0x3b, 0xee, 0x6b, 0xaa, 0xc8, 0x20,
    0xce, 0xf9, 0x38, 0x26, 0xb7, 0x80, 0x76, 0x2f, 0xa5, 0xeb, 0x33, 0x13,
    0x1b, 0x1c, 0x12, 0x14};

static const uint8_t fec_g4_k100[100] = {
    0x3c, 0x66, 0xa8, 0x11, 0xcc, 0xfa, 0x41, 0x6f, 0x0a, 0x26, 0x39, 0xf6,
    0xa0, 0xab, 0x97, 0x84, 0x82, 0x69, 0xd4, 0x43, 0xb9, 0xdc, 0x1d, 0xfe,
    0xb0, 0xe2, 0x4e, 0x60, 0x08, 0x83, 0x29, 0x24, 0xdb, 0xd8, 0xce, 0x12,
    0x8d, 0x99, 0x4b, 0x3c, 0x8b, 0x14, 0x0d, 0x4d, 0xa4, 0x60, 0xe0, 0x47,
    0xeb, 0xe8, 0x70, 0x17, 0x20, 0xfd, 0x61, 0x65, 0x45, 0xc2, 0xcc, 0x2f,
    0xc7, 0xce, 0xb5, 0x65, 0x0d, 0x74, 0x26, 0x32, 0x39, 0x76, 0x3a, 0x5e,
    0x21, 0x20, 0xb5, 0xd9, 0x75, 0x59, 0xf5, 0xf2, 0x3d, 0xb4, 0x91, 0x50,
    0x23, 0xaa, 0x74, 0xf2, 0xae, 0x94, 0x03, 0x71, 0xcd, 0xf0, 0x97, 0xa5,
    0xf5, 0xe8, 0xc4, 0xd8};

/*
 * Get G matrix coefficient using XOR pattern for rows 0-3.
 * For row 4, returns from hardcoded table.
 * For other k values, falls back to computed Vandermonde.
 */
static uint8_t get_g_coefficient(int row, int col, int k,
                                 const uint8_t *g0_table,
                                 const uint8_t *g4_table)
{
  if (row < 4)
  {
    /* XOR pattern: G[row][col] = G[0][(col/4)*4 + ((col%4) XOR row)] */
    int grp = col / 4;
    int pos = col % 4;
    int mapped_col = grp * 4 + (pos ^ row);
    return g0_table[mapped_col];
  }
  else if (row == 4)
  {
    return g4_table[col];
  }
  return 0; /* Shouldn't happen for m=5 */
}

static uint8_t rs_exp[255 + 1];
static uint16_t rs_log[255 + 1];
static int rs_fec_initialized = 0;

static void generate_gf_tables(void)
{
  uint8_t x = 0x1;
  uint16_t y = 0x1;
  unsigned int i;

  rs_exp[RS_SIZE] = 0;

  for (i = 0; i < RS_SIZE; ++i)
  {
    rs_exp[i] = x;
    y <<= 1;
    if (y & 0x100)
      y ^= RS_MODULUS;
    y %= 0x100;
    x = y;
  }

  for (i = 0; i <= RS_SIZE; ++i)
  {
    rs_log[rs_exp[i]] = i;
  }
}

void rs_fec_init(void)
{
  if (!rs_fec_initialized)
  {
    generate_gf_tables();
    rs_fec_initialized = 1;
  }
}

static int matrix_inv_gf256(uint8_t **matrix, int n)
{
  int i, j, k, l, ll;
  int irow = 0, icol = 0;
  uint8_t dum, big;
  uint16_t pivinv;

  int indxc[RS_BOUND], indxr[RS_BOUND], ipiv[RS_BOUND];
  if (n >= (int)RS_BOUND || n <= 0)
  {
    return -1;
  }

  for (j = 0; j < n; ++j)
  {
    indxc[j] = 0;
    indxr[j] = 0;
    ipiv[j] = 0;
  }

  for (i = 0; i < n; ++i)
  {
    big = 0;
    for (j = 0; j < n; ++j)
    {
      if (ipiv[j] != 1)
      {
        for (k = 0; k < n; ++k)
        {
          if (ipiv[k] == 0)
          {
            if (matrix[j][k] >= big)
            {
              big = matrix[j][k];
              irow = j;
              icol = k;
            }
          }
          else if (ipiv[k] > 1)
          {
            return -1;
          }
        }
      }
    }
    ++(ipiv[icol]);

    if (irow != icol)
    {
      for (l = 0; l < n; ++l)
        SWAP(matrix[irow][l], matrix[icol][l])
    }
    indxr[i] = irow;
    indxc[i] = icol;
    if (matrix[icol][icol] == 0)
    {
      return -1;
    }
    pivinv = RS_SIZE - rs_log[matrix[icol][icol]];
    matrix[icol][icol] = 0x1;
    for (l = 0; l < n; ++l)
      if (matrix[icol][l])
        matrix[icol][l] =
            rs_exp[(rs_log[matrix[icol][l]] + pivinv) % RS_SIZE];
    for (ll = 0; ll < n; ++ll)
      if (ll != icol)
      {
        dum = matrix[ll][icol];
        matrix[ll][icol] = 0;
        for (l = 0; l < n; ++l)
          if (matrix[icol][l] && dum)
            matrix[ll][l] ^=
                rs_exp[(rs_log[matrix[icol][l]] + rs_log[dum]) % RS_SIZE];
      }
  }

  for (l = n - 1; l >= 0; --l)
  {
    if (indxr[l] != indxc[l])
      for (k = 0; k < n; ++k)
        SWAP(matrix[k][indxr[l]], matrix[k][indxc[l]])
  }

  return 0;
}

static void matrix_mul_gf256(uint8_t **a, uint8_t **b, uint8_t **c, int left,
                             int mid, int right)
{
  int i, j, k;
  for (i = 0; i < left; ++i)
    for (j = 0; j < right; ++j)
      for (k = 0; k < mid; ++k)
      {
        if (a[i][k] && b[k][j])
        {
          c[i][j] ^= rs_exp[(rs_log[a[i][k]] + rs_log[b[k][j]]) % RS_SIZE];
        }
      }
}

rs_fec_t *rs_fec_new(int data_pkt_num, int fec_pkt_num)
{
  rs_fec_t *rs = NULL;

  if (!rs_fec_initialized)
  {
    rs_fec_init();
  }

  int i, j;

  rs = (rs_fec_t *)calloc(1, sizeof(rs_fec_t));
  if (rs == NULL)
    return NULL;

  rs->m = fec_pkt_num;
  rs->k = data_pkt_num;

  rs->en_GM = (uint8_t **)calloc(rs->m, sizeof(uint8_t *));
  rs->en_GM_buf = (uint8_t *)calloc(rs->m * rs->k, sizeof(uint8_t));

  if (rs->en_GM == NULL || rs->en_GM_buf == NULL)
  {
    goto bailout;
  }

  for (i = 0; i < rs->m; ++i)
  {
    rs->en_GM[i] = rs->en_GM_buf + i * rs->k;
  }

  /*
   * Use hardcoded G matrix for k=100, m=5 (reverse-engineered from captures).
   * For other k values, fall back to computed Vandermonde matrix.
   */
  if (data_pkt_num == 100 && fec_pkt_num == 5)
  {
    /* Use the reverse-engineered G matrix with XOR pattern */
    for (i = 0; i < rs->m; ++i)
    {
      for (j = 0; j < rs->k; ++j)
      {
        rs->en_GM[i][j] =
            get_g_coefficient(i, j, rs->k, fec_g0_k100, fec_g4_k100);
      }
    }
  }
  else
  {
    /* Fall back to standard Vandermonde-based computation */
    uint8_t **en_left = NULL;
    uint8_t **en_right = NULL;
    uint8_t *en_left_buf = NULL;
    uint8_t *en_right_buf = NULL;
    int _i, ret;

    en_left = (uint8_t **)calloc(rs->m, sizeof(uint8_t *));
    en_right = (uint8_t **)calloc(rs->k, sizeof(uint8_t *));
    en_left_buf = (uint8_t *)calloc(rs->m * rs->k, sizeof(uint8_t));
    en_right_buf = (uint8_t *)calloc(rs->k * rs->k, sizeof(uint8_t));

    if (en_left == NULL || en_right == NULL || en_left_buf == NULL ||
        en_right_buf == NULL)
    {
      free(en_left_buf);
      free(en_right_buf);
      free(en_left);
      free(en_right);
      goto bailout;
    }

    for (i = 0, _i = rs->k; i < rs->m; ++i, ++_i)
    {
      en_left[i] = en_left_buf + i * rs->k;
      for (j = 0; j < rs->k; ++j)
      {
        en_left[i][j] = rs_exp[(_i * j) % RS_SIZE];
        rs->en_GM[i][j] = 0;
      }
    }

    for (i = 0; i < rs->k; ++i)
    {
      en_right[i] = en_right_buf + i * rs->k;
      for (j = 0; j < rs->k; ++j)
        en_right[i][j] = rs_exp[(i * j) % RS_SIZE];
    }

    ret = matrix_inv_gf256(en_right, rs->k);
    if (ret != 0)
    {
      free(en_left_buf);
      free(en_right_buf);
      free(en_left);
      free(en_right);
      goto bailout;
    }

    matrix_mul_gf256(en_left, en_right, rs->en_GM, rs->m, rs->k, rs->k);

    free(en_left_buf);
    free(en_right_buf);
    free(en_left);
    free(en_right);
  }

  return rs;

bailout:
  free(rs->en_GM_buf);
  free(rs->en_GM);
  free(rs);

  return NULL;
}

void rs_fec_free(rs_fec_t *p)
{
  if (p != NULL)
  {
    free(p->en_GM_buf);
    free(p->en_GM);
    free(p);
  }
}

int rs_fec_decode(rs_fec_t *code, uint8_t **data, uint8_t **fec_data,
                  int lost_map[], int data_len)
{
  int N = code->k + code->m;
  int S = data_len;

  int recv_count = 0;
  int tmp_count = 0;
  int i, j, r, l;
  int lost_pkt_cnt = 0;

  int lost_pkt_id[RS_SIZE + 1];
  uint8_t *de_subGM_buf = NULL;
  uint8_t **de_subGM = NULL;
  uint8_t **recv_data = NULL;

  for (i = 0; i < (int)(RS_SIZE + 1); i++)
  {
    lost_pkt_id[i] = 0;
  }

  de_subGM = (uint8_t **)calloc(code->k, sizeof(uint8_t *));
  if (de_subGM == NULL)
  {
    return -1;
  }
  for (i = 0; i < code->k; ++i)
    de_subGM[i] = NULL;

  de_subGM_buf = (uint8_t *)calloc(code->k * code->k, sizeof(uint8_t));
  if (de_subGM_buf == NULL)
  {
    free(de_subGM);
    return -1;
  }

  for (i = 0; i < code->k; ++i)
  {
    de_subGM[i] = de_subGM_buf + code->k * i;
    for (j = 0; j < code->k; ++j)
      de_subGM[i][j] = 0;
  }

  for (i = 0; i < code->k; ++i)
  {
    if (lost_map[i] == 1)
    {
      de_subGM[recv_count][i] = 1;
      ++recv_count;
    }
    else if (lost_pkt_cnt < code->m)
    {
      lost_pkt_id[lost_pkt_cnt++] = i;
    }
    else
    {
      free(de_subGM_buf);
      free(de_subGM);
      return -1;
    }
  }

  for (i = code->k; i < N; ++i)
  {
    if (lost_map[i] == 1)
    {
      if (recv_count < code->k)
      {
        for (j = 0; j < code->k; ++j)
          de_subGM[recv_count][j] = code->en_GM[i - code->k][j];
        ++recv_count;
      }
      else
        break;
    }
  }

  if (matrix_inv_gf256(de_subGM, code->k) == -1)
  {
    free(de_subGM);
    free(de_subGM_buf);
    return -1;
  }

  recv_data = (uint8_t **)calloc(code->k, sizeof(uint8_t *));
  if (recv_data == NULL)
  {
    free(de_subGM);
    free(de_subGM_buf);
    return -1;
  }

  for (i = 0; i < N; ++i)
  {
    if (lost_map[i])
    {
      if (i < code->k)
        recv_data[tmp_count] = data[i];
      else
        recv_data[tmp_count] = fec_data[i - code->k];
      ++tmp_count;
    }
    if (tmp_count == code->k)
    {
      break;
    }
  }

  for (i = 0; i < lost_pkt_cnt; ++i)
  {
    int cur_lost_pkt = lost_pkt_id[i];
    memset(data[cur_lost_pkt], 0, S);
    for (r = 0; r < S; ++r)
    {
      for (l = 0; l < code->k; ++l)
      {
        if (de_subGM[cur_lost_pkt][l] && recv_data[l][r])
          data[cur_lost_pkt][r] ^=
              rs_exp[(rs_log[de_subGM[cur_lost_pkt][l]] +
                      rs_log[recv_data[l][r]]) %
                     (RS_SIZE)];
      }
    }
  }

  free(recv_data);
  free(de_subGM);
  free(de_subGM_buf);

  return 0;
}
